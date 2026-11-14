//! The window context poll (ADR 0022 Phase 3): what the user is looking at in other apps.

use std::collections::HashSet;
use std::time::Duration;

use super::{LABEL, Overlay};
use crate::context::{self, Change, WindowContext};
use tauri::{AppHandle, Emitter, Manager};

/// Which context poll thread may run. Every start takes a new `generation`; a thread still inside
/// a slow poll when it was stopped (or replaced) sees that it is not the current one and ends
/// without storing or sending anything.
#[derive(Default)]
pub(super) struct Poll {
    generation: u64,
    running: bool,
}

impl Poll {
    /// Whether the thread started as `generation` is the running poll.
    fn is_current(&self, generation: u64) -> bool {
        self.running && self.generation == generation
    }
}

/// The window context state shared by the poll and the AppleScript threads.
#[derive(Default)]
pub(super) struct Capture {
    /// Counts new contexts: a level 2 result for an older one is dropped.
    pub(super) id: u64,
    pub(super) ctx: Option<WindowContext>,
    /// Level 2 is done for `id` (or there is none for its app).
    done: bool,
    /// The overlay was just shown: the next reading is sent even when it did not change, and
    /// Harness frontmost clears the context (it would be stale).
    fresh: bool,
    /// Apps with an AppleScript running: one at a time per app.
    scripts: HashSet<String>,
}

/// How often the context poll reads levels 0 and 1.
const POLL: Duration = Duration::from_secs(1);
/// How long a new context waits for its AppleScript before it is sent without it.
const SCRIPT_WAIT: Duration = Duration::from_millis(1500);

/// Starts the context poll (when the setting is on), unless it runs. `fresh`: the overlay was just
/// shown, so the first reading is sent.
pub(super) fn start_context(app: &AppHandle, fresh: bool) {
    let state = app.state::<Overlay>();
    if !state.settings.lock().window_context {
        return;
    }
    if fresh {
        state.context.lock().fresh = true;
    }
    let generation = {
        let mut poll = state.poll.lock();
        if poll.running {
            return;
        }
        poll.generation += 1;
        poll.running = true;
        poll.generation
    };
    let handle = app.clone();
    std::thread::spawn(move || {
        let current = || handle.state::<Overlay>().poll.lock().is_current(generation);
        while current() {
            poll_context(&handle, generation);
            for _ in 0..10 {
                if !current() {
                    return;
                }
                std::thread::sleep(POLL / 10);
            }
        }
    });
}

/// Stops the context poll (hidden, chat, mini, setting off). A running AppleScript still finishes.
pub(super) fn stop_context(app: &AppHandle) {
    app.state::<Overlay>().poll.lock().running = false;
}

/// One poll: reads levels 0 and 1; on a new app, window or document runs level 2 and sends the
/// context (after the AppleScript, or without it after `SCRIPT_WAIT`). Harness itself frontmost
/// (the user clicked a Harness window) keeps the last context.
fn poll_context(app: &AppHandle, generation: u64) {
    let state = app.state::<Overlay>();
    if !state.settings.lock().window_context {
        return;
    }
    // Checked with the context lock held, before anything is stored or sent: a stopped or replaced poll stays silent.
    let current = || state.poll.lock().is_current(generation);
    let Some(mut next) = context::capture() else {
        let mut c = state.context.lock();
        if !current() {
            return;
        }
        if std::mem::take(&mut c.fresh) && c.ctx.is_some() {
            c.id += 1;
            c.ctx = None;
            c.done = true;
            let _ = app.emit_to(LABEL, "overlay-context", None::<WindowContext>);
        }
        return;
    };
    context::accessibility(&mut next);
    let adapter = context::adapter(&next.bundle_id);
    let id = {
        let mut c = state.context.lock();
        if !current() {
            return;
        }
        let fresh = std::mem::take(&mut c.fresh);
        match context::change(c.ctx.as_ref(), &next) {
            Change::Same if !fresh => return,
            Change::Selection if !fresh => {
                if let Some(ctx) = c.ctx.as_mut() {
                    ctx.selected_text = next.selected_text;
                    let _ = app.emit_to(LABEL, "overlay-context", Some(&*ctx));
                }
                return;
            }
            _ => {}
        }
        c.id += 1;
        c.done = adapter.is_none();
        if c.done {
            let _ = app.emit_to(LABEL, "overlay-context", Some(&next));
        } else if c.scripts.insert(next.bundle_id.clone()) {
            let (handle, bundle) = (app.clone(), next.bundle_id.clone());
            std::thread::spawn(move || run_scripts(&handle, &bundle));
        }
        c.ctx = Some(next);
        if c.done {
            return;
        }
        c.id
    };
    // Sent with level 2 when it comes in time (no chip that changes a moment later).
    let start = std::time::Instant::now();
    while start.elapsed() < SCRIPT_WAIT {
        std::thread::sleep(Duration::from_millis(50));
        let c = state.context.lock();
        if c.id != id || c.done || !current() {
            return;
        }
    }
    let c = state.context.lock();
    if c.id == id && !c.done && current() {
        let _ = app.emit_to(LABEL, "overlay-context", c.ctx.as_ref());
    }
}

/// Runs level 2 for `bundle_id` while the current context is that app's and still needs it, one
/// AppleScript at a time. A result for an older context is dropped; the newer one runs next.
fn run_scripts(app: &AppHandle, bundle_id: &str) {
    let state = app.state::<Overlay>();
    let Some(adapter) = context::adapter(bundle_id) else { return };
    loop {
        let id = {
            let mut c = state.context.lock();
            match &c.ctx {
                Some(ctx) if ctx.bundle_id == bundle_id && !c.done => c.id,
                _ => {
                    c.scripts.remove(bundle_id);
                    return;
                }
            }
        };
        let result = context::run_script(adapter, bundle_id);
        let mut c = state.context.lock();
        if c.id != id {
            continue;
        }
        if let Some(ctx) = c.ctx.as_mut() {
            if let Some(e) = context::apply_script(adapter, result, ctx) {
                tracing::warn!("window context: AppleScript for {bundle_id} failed: {e}");
            }
            let _ = app.emit_to(LABEL, "overlay-context", Some(&*ctx));
        }
        c.done = true;
    }
}

#[cfg(test)]
mod tests {
    use super::Poll;

    #[test]
    fn only_the_running_poll_of_the_current_generation_is_current() {
        let mut poll = Poll::default();
        assert!(!poll.is_current(0), "nothing runs yet");
        poll.generation += 1;
        poll.running = true;
        assert!(poll.is_current(1));
        poll.running = false;
        assert!(!poll.is_current(1), "stopped");
        poll.generation += 1;
        poll.running = true;
        assert!(!poll.is_current(1), "replaced by a newer start");
        assert!(poll.is_current(2));
    }
}
