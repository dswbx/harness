//! `AppEvents`: fan-out of `AppEvent`s to the app's windows.

use std::sync::Arc;

type AppSink = Arc<dyn Fn(&crate::api::AppEvent) -> bool + Send + Sync>;

/// Fan-out of `AppEvent`s to subscribers (the app's windows).
///
/// Sinks are called with no lock held: a sink may block (the app's sinks wait for the main thread)
/// or subscribe, unsubscribe and emit itself. Events still reach every sink in the order they were
/// emitted: one thread at a time delivers, and an `emit` that finds a delivery running only queues
/// its event for that thread.
#[derive(Default)]
pub struct AppEvents {
    subs: parking_lot::Mutex<(u64, Vec<(u64, AppSink)>)>,
    queue: parking_lot::Mutex<std::collections::VecDeque<crate::api::AppEvent>>,
    /// Held by the thread that delivers the queue.
    delivering: parking_lot::Mutex<()>,
}

impl AppEvents {
    pub fn subscribe(&self, sink: Box<dyn Fn(&crate::api::AppEvent) -> bool + Send + Sync>) -> u64 {
        let mut s = self.subs.lock();
        s.0 += 1;
        let id = s.0;
        s.1.push((id, Arc::from(sink)));
        id
    }

    /// A delivery already under way may still call the sink once more.
    pub fn unsubscribe(&self, id: u64) {
        self.subs.lock().1.retain(|(i, _)| *i != id);
    }

    pub fn emit(&self, event: crate::api::AppEvent) {
        self.queue.lock().push_back(event);
        loop {
            {
                let Some(_delivering) = self.delivering.try_lock() else { return };
                loop {
                    // Not `while let`: its scrutinee would keep the queue locked through the body.
                    let next = self.queue.lock().pop_front();
                    let Some(event) = next else { break };
                    let sinks = self.subs.lock().1.clone();
                    let gone: Vec<u64> = sinks.iter().filter(|(_, sink)| !sink(&event)).map(|(id, _)| *id).collect();
                    if !gone.is_empty() {
                        self.subs.lock().1.retain(|(id, _)| !gone.contains(id));
                    }
                }
            }
            // An emit that queued its event after the last look, and found the delivery still
            // held, left that event to this thread.
            if self.queue.lock().is_empty() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod app_events_tests {
    use super::*;
    use crate::api::AppEvent;
    use std::sync::Mutex;
    use std::time::Duration;

    fn named(n: impl ToString) -> AppEvent {
        AppEvent::TerminalsChanged { session_id: n.to_string() }
    }

    fn name(e: &AppEvent) -> String {
        match e {
            AppEvent::TerminalsChanged { session_id } => session_id.clone(),
            _ => "other".into(),
        }
    }

    /// The app's sinks wait for the main thread, which itself subscribes and unsubscribes.
    #[test]
    fn a_sink_can_wait_for_another_thread_that_subscribes_and_unsubscribes() {
        let events = Arc::new(AppEvents::default());
        let (other, done) = (events.clone(), Arc::new(Mutex::new(false)));
        let seen = done.clone();
        events.subscribe(Box::new(move |_| {
            let (other, (tx, rx)) = (other.clone(), std::sync::mpsc::channel());
            std::thread::spawn(move || {
                let id = other.subscribe(Box::new(|_| true));
                other.unsubscribe(id);
                let _ = tx.send(());
            });
            *seen.lock().unwrap() = rx.recv_timeout(Duration::from_secs(5)).is_ok();
            true
        }));
        events.emit(AppEvent::SessionsChanged);
        assert!(*done.lock().unwrap(), "subscribe and unsubscribe went through while a sink was running");
    }

    #[test]
    fn an_emit_from_inside_a_sink_is_delivered_after_the_current_event() {
        let events = Arc::new(AppEvents::default());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (again, log) = (events.clone(), seen.clone());
        events.subscribe(Box::new(move |e| {
            log.lock().unwrap().push(format!("first:{}", name(e)));
            if name(e) == "a" {
                again.emit(named("b"));
            }
            true
        }));
        let log = seen.clone();
        events.subscribe(Box::new(move |e| {
            log.lock().unwrap().push(format!("second:{}", name(e)));
            true
        }));
        events.emit(named("a"));
        assert_eq!(*seen.lock().unwrap(), ["first:a", "second:a", "first:b", "second:b"]);
    }

    #[test]
    fn a_sink_that_returns_false_or_was_unsubscribed_gets_no_more_events() {
        let events = AppEvents::default();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        events.subscribe(Box::new(move |e| {
            log.lock().unwrap().push(format!("once:{}", name(e)));
            false
        }));
        let log = seen.clone();
        let gone = events.subscribe(Box::new(move |e| {
            log.lock().unwrap().push(format!("gone:{}", name(e)));
            true
        }));
        events.emit(named("a"));
        events.unsubscribe(gone);
        events.emit(named("b"));
        assert_eq!(*seen.lock().unwrap(), ["once:a", "gone:a"]);
    }

    #[test]
    fn concurrent_emits_all_arrive_in_one_order_for_every_sink() {
        let events = Arc::new(AppEvents::default());
        let logs: Vec<_> = (0..2).map(|_| Arc::new(Mutex::new(Vec::new()))).collect();
        for log in &logs {
            let log = log.clone();
            events.subscribe(Box::new(move |e| {
                log.lock().unwrap().push(name(e));
                true
            }));
        }
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let events = events.clone();
                std::thread::spawn(move || (0..200).for_each(|i| events.emit(named(format!("{t}:{i}")))))
            })
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        let (a, b) = (logs[0].lock().unwrap().clone(), logs[1].lock().unwrap().clone());
        assert_eq!(a.len(), 1600);
        assert_eq!(a, b);
        // Each thread's own events keep their order.
        for t in 0..8 {
            let own: Vec<usize> = a.iter().filter_map(|n| n.strip_prefix(&format!("{t}:")).map(|i| i.parse().unwrap())).collect();
            assert_eq!(own, (0..200).collect::<Vec<_>>());
        }
    }
}
