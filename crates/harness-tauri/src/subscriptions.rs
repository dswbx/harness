//! What each webview is subscribed to (Session Logs, AppEvents, Terminals), so a reload or a
//! closed window drops them all and never leaks one. Knows labels and the `Harness`, not Tauri.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::Ordering;

use harness_core::Harness;
use harness_core::api::{AppEvent, EventSink};
use harness_core::terminal::TerminalSink;

/// Receives AppEvents; returns `false` to unsubscribe.
type AppSink = Box<dyn Fn(&AppEvent) -> bool + Send + Sync>;

/// (session id, terminal id, terminal attach id).
type TerminalAttach = (String, u32, u64);

#[derive(Default)]
pub struct Subscriptions {
    /// Webview label -> (session id, subscription id).
    by_webview: Mutex<HashMap<String, Vec<(String, u64)>>>,
    /// Webview label -> app subscription ids.
    app_by_webview: Mutex<HashMap<String, Vec<u64>>>,
    /// Webview label -> (session id, terminal id, terminal attach id).
    terminals_by_webview: Mutex<HashMap<String, Vec<TerminalAttach>>>,
    /// Webview label -> how many times it was dropped (reload, closed). A subscription started
    /// before a drop must not register after it.
    generations: Mutex<HashMap<String, u64>>,
    /// Source of generations: never reused, so a pruned label cannot match an old one.
    next_generation: std::sync::atomic::AtomicU64,
}

/// What a webview held, still to be released in the core (which may block on a log lock).
pub struct Dropped {
    sessions: Vec<(String, u64)>,
    app: Vec<u64>,
    terminals: Vec<TerminalAttach>,
}

impl Dropped {
    pub fn release(self, harness: &Harness) {
        for (session_id, id) in self.sessions {
            harness.unsubscribe_session(&session_id, id);
        }
        for id in self.app {
            harness.unsubscribe_app(id);
        }
        for (session_id, terminal_id, id) in self.terminals {
            harness.terminal_detach(&session_id, terminal_id, id);
        }
    }
}

impl Subscriptions {
    /// The webview's current generation: read when a command starts, before its blocking part.
    pub fn generation(&self, label: &str) -> u64 {
        let mut gens = self.generations.lock();
        *gens.entry(label.to_owned()).or_insert_with(|| self.next_generation.fetch_add(1, Ordering::Relaxed))
    }

    /// Subscribes the webview to a Session Log, as of now.
    #[cfg(test)]
    pub fn subscribe(&self, harness: &Harness, label: &str, session_id: &str, from_seq: u64, sink: Box<dyn EventSink>) -> Result<u64, String> {
        self.subscribe_at(harness, label, self.generation(label), session_id, from_seq, sink)
    }

    /// Subscribes for the webview as of `generation`. When the webview was dropped meanwhile the
    /// subscription is released again and this fails: nobody is left to hear it.
    pub fn subscribe_at(
        &self,
        harness: &Harness,
        label: &str,
        generation: u64,
        session_id: &str,
        from_seq: u64,
        sink: Box<dyn EventSink>,
    ) -> Result<u64, String> {
        let id = harness.subscribe_session(session_id, from_seq, sink)?;
        let mut map = self.by_webview.lock();
        if self.generation(label) != generation {
            drop(map);
            harness.unsubscribe_session(session_id, id);
            return Err("the window was reloaded".to_owned());
        }
        map.entry(label.to_owned()).or_default().push((session_id.to_owned(), id));
        Ok(id)
    }

    pub fn unsubscribe(&self, harness: &Harness, label: &str, session_id: &str, id: u64) {
        harness.unsubscribe_session(session_id, id);
        if let Some(list) = self.by_webview.lock().get_mut(label) {
            list.retain(|(s, i)| !(s == session_id && *i == id));
        }
    }

    /// Subscribes the webview to Harness-wide events.
    pub fn subscribe_app(&self, harness: &Harness, label: &str, sink: AppSink) -> u64 {
        let id = harness.subscribe_app(sink);
        self.app_by_webview.lock().entry(label.to_owned()).or_default().push(id);
        id
    }

    /// Attaches the webview to a Terminal tab.
    #[cfg(test)]
    #[allow(clippy::too_many_arguments, reason = "mirrors the Tauri command's IPC arguments")]
    pub fn terminal_attach(
        &self,
        harness: &Harness,
        label: &str,
        session_id: &str,
        terminal_id: u32,
        cols: u16,
        rows: u16,
        sink: TerminalSink,
    ) -> Result<u64, String> {
        self.terminal_attach_at(harness, label, self.generation(label), session_id, terminal_id, cols, rows, sink)
    }

    /// As `subscribe_at`, for a Terminal.
    #[allow(clippy::too_many_arguments, reason = "mirrors the Tauri command's IPC arguments")]
    pub fn terminal_attach_at(
        &self,
        harness: &Harness,
        label: &str,
        generation: u64,
        session_id: &str,
        terminal_id: u32,
        cols: u16,
        rows: u16,
        sink: TerminalSink,
    ) -> Result<u64, String> {
        let id = harness.terminal_attach(session_id, terminal_id, cols, rows, sink).map_err(|e| format!("{e:#}"))?;
        let mut map = self.terminals_by_webview.lock();
        if self.generation(label) != generation {
            drop(map);
            harness.terminal_detach(session_id, terminal_id, id);
            return Err("the window was reloaded".to_owned());
        }
        map.entry(label.to_owned()).or_default().push((session_id.to_owned(), terminal_id, id));
        Ok(id)
    }

    pub fn terminal_detach(&self, harness: &Harness, label: &str, session_id: &str, terminal_id: u32, id: u64) {
        harness.terminal_detach(session_id, terminal_id, id);
        if let Some(list) = self.terminals_by_webview.lock().get_mut(label) {
            list.retain(|(s, t, i)| !(s == session_id && *t == terminal_id && *i == id));
        }
    }

    /// The window is gone for good: its generation is no longer needed.
    pub fn forget_label(&self, label: &str) {
        self.generations.lock().remove(label);
    }

    /// Forgets every subscription of the webview: it reloaded or its window is gone. Cheap (maps
    /// only), so it runs on the main thread; `Dropped::release` does the core's part.
    pub fn take_webview(&self, label: &str) -> Dropped {
        // Bumped first: a registration that checks after this fails, one before is removed below.
        self.generations.lock().insert(label.to_owned(), self.next_generation.fetch_add(1, Ordering::Relaxed));
        Dropped {
            sessions: self.by_webview.lock().remove(label).unwrap_or_default(),
            app: self.app_by_webview.lock().remove(label).unwrap_or_default(),
            terminals: self.terminals_by_webview.lock().remove(label).unwrap_or_default(),
        }
    }

    #[cfg(test)]
    fn drop_webview(&self, harness: &Harness, label: &str) {
        self.take_webview(label).release(harness);
    }

    /// How many subscriptions the webview holds: (Session Logs, app, Terminals).
    #[cfg(test)]
    fn counts(&self, label: &str) -> (usize, usize, usize) {
        let n = |len: Option<usize>| len.unwrap_or(0);
        (
            n(self.by_webview.lock().get(label).map(Vec::len)),
            n(self.app_by_webview.lock().get(label).map(Vec::len)),
            n(self.terminals_by_webview.lock().get(label).map(Vec::len)),
        )
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "tests fail loudly")]
    use super::*;
    use harness_core::api::{AgentInfo, Command, CommandResult, Event, FrontendManifest};
    use harness_core::terminal::TerminalOutput;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    async fn harness() -> (Arc<Harness>, String, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let agent = AgentInfo {
            id: "a".into(),
            name: "A".into(),
            command: "true".into(),
            args: vec![],
            env: Default::default(),
            source: Default::default(),
            version: None,
            icon: None,
            install: Default::default(),
        };
        let h = Harness::with_options(dir.path().join("data"), vec![agent], Default::default()).unwrap();
        h.register_frontend(FrontendManifest { id: "chat".into(), name: "C".into(), version: "0".into(), instructions: None, frontend_tools: vec![] });
        let create = Command::CreateSession {
            folder: dir.path().display().to_string(),
            agent_id: "a".into(),
            frontend_id: "chat".into(),
            title: None,
            branch: None,
            worktree: false,
            new_branch: None,
            pr: None,
            mcp_servers: vec![],
        };
        let CommandResult::SessionCreated { session_id } = h.execute(create).await.unwrap() else { panic!() };
        (h, session_id, dir)
    }

    /// A Session sink that counts what it receives.
    fn counting() -> (Arc<AtomicUsize>, Box<dyn EventSink>) {
        let n = Arc::new(AtomicUsize::new(0));
        let seen = n.clone();
        (
            n,
            Box::new(move |_: &Event| {
                seen.fetch_add(1, Ordering::SeqCst);
                true
            }),
        )
    }

    fn app_counting() -> (Arc<AtomicUsize>, AppSink) {
        let n = Arc::new(AtomicUsize::new(0));
        let seen = n.clone();
        (
            n,
            Box::new(move |_: &AppEvent| {
                seen.fetch_add(1, Ordering::SeqCst);
                true
            }),
        )
    }

    /// Something that logs an Event in the Session and emits an AppEvent.
    async fn poke(h: &Harness, sid: &str) {
        h.execute(Command::ArchiveSession { session_id: sid.into() }).await.unwrap();
    }

    async fn eventually(what: &str, f: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !f() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Lets a quiet period pass, for "nothing arrives" assertions.
    async fn settle() {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_subscription_is_added_and_unsubscribed_alone() {
        let (h, sid, _dir) = harness().await;
        let subs = Subscriptions::default();
        let (a, sink_a) = counting();
        let (b, sink_b) = counting();
        let id_a = subs.subscribe(&h, "main", &sid, 0, sink_a).unwrap();
        let id_b = subs.subscribe(&h, "main", &sid, 0, sink_b).unwrap();
        assert_ne!(id_a, id_b);
        assert_eq!(subs.counts("main"), (2, 0, 0));
        // Both replay the log so far.
        eventually("the replay", || a.load(Ordering::SeqCst) > 0 && b.load(Ordering::SeqCst) > 0).await;

        subs.unsubscribe(&h, "main", &sid, id_a);
        assert_eq!(subs.counts("main"), (1, 0, 0));
        settle().await;
        let (a_before, b_before) = (a.load(Ordering::SeqCst), b.load(Ordering::SeqCst));
        poke(&h, &sid).await;
        eventually("the remaining subscription to hear", || b.load(Ordering::SeqCst) > b_before).await;
        settle().await;
        assert_eq!(a.load(Ordering::SeqCst), a_before, "the unsubscribed sink hears nothing more");

        // Unknown subscriptions and labels are ignored.
        subs.unsubscribe(&h, "main", &sid, 9999);
        subs.unsubscribe(&h, "nobody", &sid, id_b);
        assert_eq!(subs.counts("main"), (1, 0, 0));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_subscription_started_before_a_reload_is_not_registered_after_it() {
        let (h, sid, _dir) = harness().await;
        let subs = Subscriptions::default();
        let started_at = subs.generation("main");
        // The reload lands between the command starting and the subscription registering.
        subs.take_webview("main").release(&h);
        let (n, sink) = counting();
        assert!(subs.subscribe_at(&h, "main", started_at, &sid, 0, sink).is_err());
        assert_eq!(subs.counts("main"), (0, 0, 0));
        // The replay thread may hand over the backlog before the release lands; what matters is
        // that nothing new arrives afterwards.
        settle().await;
        let before = n.load(Ordering::SeqCst);
        poke(&h, &sid).await;
        settle().await;
        assert_eq!(n.load(Ordering::SeqCst), before, "the stale subscription was released: nothing new is delivered");

        let CommandResult::TerminalOpened { terminal_id } = h.execute(Command::TerminalOpen { session_id: sid.clone() }).await.unwrap() else { panic!() };
        let started_at = subs.generation("main");
        subs.take_webview("main").release(&h);
        let (_, term) = terminal_sink();
        assert!(subs.terminal_attach_at(&h, "main", started_at, &sid, terminal_id, 80, 24, term).is_err());
        assert_eq!(subs.counts("main"), (0, 0, 0));

        // After the reload, a fresh one registers.
        let (_, sink) = counting();
        subs.subscribe(&h, "main", &sid, 0, sink).unwrap();
        assert_eq!(subs.counts("main"), (1, 0, 0));
        h.execute(Command::TerminalClose { session_id: sid.clone(), terminal_id }).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_subscription_to_a_missing_session_is_an_error_and_not_tracked() {
        let (h, _sid, _dir) = harness().await;
        let subs = Subscriptions::default();
        let (_, sink) = counting();
        assert!(subs.subscribe(&h, "main", "no-such-session", 0, sink).is_err());
        assert_eq!(subs.counts("main"), (0, 0, 0));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dropping_a_webview_removes_all_its_subscriptions_and_only_its() {
        let (h, sid, _dir) = harness().await;
        let subs = Subscriptions::default();

        let (main_log, sink) = counting();
        subs.subscribe(&h, "main", &sid, 0, sink).unwrap();
        let (main_app, sink) = app_counting();
        subs.subscribe_app(&h, "main", sink);
        let (_, main_term) = terminal_sink();
        let term_id = h.execute(Command::TerminalOpen { session_id: sid.clone() }).await.unwrap();
        let CommandResult::TerminalOpened { terminal_id } = term_id else { panic!("{term_id:?}") };
        subs.terminal_attach(&h, "main", &sid, terminal_id, 80, 24, main_term).unwrap();
        assert_eq!(subs.counts("main"), (1, 1, 1));

        let (other_log, sink) = counting();
        subs.subscribe(&h, "overlay", &sid, 0, sink).unwrap();
        let (other_app, sink) = app_counting();
        subs.subscribe_app(&h, "overlay", sink);
        assert_eq!(subs.counts("overlay"), (1, 1, 0));
        eventually("the replays", || main_log.load(Ordering::SeqCst) > 0 && other_log.load(Ordering::SeqCst) > 0).await;

        subs.drop_webview(&h, "main");
        assert_eq!(subs.counts("main"), (0, 0, 0));
        assert_eq!(subs.counts("overlay"), (1, 1, 0), "the other webview keeps its own");

        settle().await;
        let before = (main_log.load(Ordering::SeqCst), main_app.load(Ordering::SeqCst), other_log.load(Ordering::SeqCst), other_app.load(Ordering::SeqCst));
        poke(&h, &sid).await;
        eventually("the other webview to hear both", || other_log.load(Ordering::SeqCst) > before.2 && other_app.load(Ordering::SeqCst) > before.3).await;
        settle().await;
        assert_eq!((main_log.load(Ordering::SeqCst), main_app.load(Ordering::SeqCst)), (before.0, before.1), "the dropped webview hears nothing");

        // Dropping again, or a label that never subscribed, is a no-op.
        subs.drop_webview(&h, "main");
        subs.drop_webview(&h, "never-seen");
        assert_eq!(subs.counts("overlay"), (1, 1, 0));
        subs.drop_webview(&h, "overlay");
        assert_eq!(subs.counts("overlay"), (0, 0, 0));
        h.execute(Command::TerminalClose { session_id: sid.clone(), terminal_id }).await.unwrap();
    }

    /// A Terminal sink that records nothing but keeps the attachment alive.
    fn terminal_sink() -> (Arc<AtomicUsize>, TerminalSink) {
        let n = Arc::new(AtomicUsize::new(0));
        let seen = n.clone();
        (
            n,
            Box::new(move |o: TerminalOutput| {
                seen.fetch_add(1, Ordering::SeqCst);
                !matches!(o, TerminalOutput::Exit(_))
            }),
        )
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn terminal_attachments_are_tracked_and_detached_one_by_one() {
        let (h, sid, _dir) = harness().await;
        let subs = Subscriptions::default();
        let CommandResult::TerminalOpened { terminal_id } = h.execute(Command::TerminalOpen { session_id: sid.clone() }).await.unwrap() else { panic!() };
        let (_, a) = terminal_sink();
        let (_, b) = terminal_sink();
        let id_a = subs.terminal_attach(&h, "main", &sid, terminal_id, 80, 24, a).unwrap();
        let id_b = subs.terminal_attach(&h, "main", &sid, terminal_id, 80, 24, b).unwrap();
        assert_eq!(subs.counts("main"), (0, 0, 2));
        subs.terminal_detach(&h, "main", &sid, terminal_id, id_a);
        assert_eq!(subs.counts("main"), (0, 0, 1));
        subs.terminal_detach(&h, "main", &sid, terminal_id, id_a);
        assert_eq!(subs.counts("main"), (0, 0, 1), "detaching twice changes nothing");
        // A failed attach is not tracked.
        let (_, c) = terminal_sink();
        assert!(subs.terminal_attach(&h, "main", &sid, 999, 80, 24, c).is_err());
        assert_eq!(subs.counts("main"), (0, 0, 1));
        subs.terminal_detach(&h, "main", &sid, terminal_id, id_b);
        assert_eq!(subs.counts("main"), (0, 0, 0));
        h.execute(Command::TerminalClose { session_id: sid.clone(), terminal_id }).await.unwrap();
    }
}
