//! Lumo's live icons. The installed app icon can't move, but while Lumo runs the tray (menu bar)
//! icon, the window icons (the taskbar on Windows and Linux) and the Dock icon on macOS can: a light
//! sweeps across the blue knot's fur now and then while idle, the knot turns slowly with a shimmer
//! while Lumo works, and it bounces when a reply is ready or something needs you. Settings > General
//! > "Animated icon" turns it off.
//!
//! The frames are made from the knot artwork (apps/desktop/scripts/make-icons.py) and embedded in
//! the binary. A small thread swaps them, only when the frame actually changes.

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::image::Image;
use tauri::AppHandle;
#[cfg(not(target_os = "macos"))]
use tauri::Manager;

use crate::agent::events::AgentEvent;
use crate::core::Core;

macro_rules! frames {
    ($($name:literal),* $(,)?) => { &[$(include_bytes!(concat!("../icons/live/", $name, ".png"))),*] };
}

const IDLE: &[&[u8]] = frames!("idle-0");
const BLINK: &[&[u8]] = frames!("blink-0", "blink-1", "blink-2", "blink-3", "blink-4", "blink-5");
const WORK: &[&[u8]] = frames!(
    "work-0", "work-1", "work-2", "work-3", "work-4", "work-5", "work-6", "work-7", "work-8", "work-9", "work-10", "work-11", "work-12",
    "work-13", "work-14", "work-15", "work-16", "work-17", "work-18", "work-19", "work-20", "work-21", "work-22", "work-23"
);
const WAVE: &[&[u8]] = frames!("wave-0", "wave-1", "wave-2", "wave-3", "wave-4", "wave-5", "wave-6", "wave-7", "wave-8", "wave-9");

/// One frame every TICK while something plays (12.5 frames a second).
const TICK: Duration = Duration::from_millis(80);
/// Seconds between blinks while idle (the low end, plus up to the spread).
const BLINK_EVERY: f64 = 5.0;
const BLINK_SPREAD: f64 = 4.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Clip {
    Idle,
    Blink,
    Work,
    Wave,
}

fn clip_frames(c: Clip) -> &'static [&'static [u8]] {
    match c {
        Clip::Idle => IDLE,
        Clip::Blink => BLINK,
        Clip::Work => WORK,
        Clip::Wave => WAVE,
    }
}

/// Which frame to show when: a pure state machine, so it can be tested without a window.
#[derive(Debug)]
pub struct Animator {
    clip: Clip,
    frame: usize,
    working: bool,
    wave_pending: bool,
    next_blink: f64,
}

impl Animator {
    pub fn new(now: f64) -> Self {
        Self { clip: Clip::Idle, frame: 0, working: false, wave_pending: false, next_blink: now + BLINK_EVERY }
    }

    pub fn set_working(&mut self, working: bool) {
        self.working = working;
    }

    /// Wave once (a reply is ready, or something needs the user). Plays after the current clip.
    pub fn wave(&mut self) {
        self.wave_pending = true;
    }

    /// Advance one tick. `rand01` spaces the blinks. Returns the clip and frame to show.
    pub fn tick(&mut self, now: f64, rand01: f64) -> (Clip, usize) {
        let len = clip_frames(self.clip).len();
        let finished = self.frame + 1 >= len;
        match self.clip {
            // Looping clips: work loops while working; idle just holds.
            Clip::Work if self.working && !self.wave_pending => self.frame = (self.frame + 1) % len,
            Clip::Idle if !self.working && !self.wave_pending => {
                if now >= self.next_blink {
                    self.next_blink = now + BLINK_EVERY + rand01 * BLINK_SPREAD;
                    self.start(Clip::Blink);
                }
            }
            // One-shots run to their end before anything else starts.
            Clip::Blink | Clip::Wave if !finished => self.frame += 1,
            _ => {
                if self.wave_pending {
                    self.wave_pending = false;
                    self.start(Clip::Wave);
                } else if self.working {
                    self.start(Clip::Work);
                } else {
                    self.start(Clip::Idle);
                }
            }
        }
        (self.clip, self.frame)
    }

    fn start(&mut self, clip: Clip) {
        self.clip = clip;
        self.frame = 0;
    }
}

static ANIMATOR: OnceLock<Mutex<Animator>> = OnceLock::new();
static RUNS: AtomicI32 = AtomicI32::new(0);
static STARTED: AtomicBool = AtomicBool::new(false);

fn animator() -> &'static Mutex<Animator> {
    ANIMATOR.get_or_init(|| Mutex::new(Animator::new(0.0)))
}

/// Feed every agent event through here (from the app's event sink).
pub fn on_agent_event(ev: &AgentEvent) {
    match ev {
        AgentEvent::RunStarted { .. } => {
            RUNS.fetch_add(1, Ordering::SeqCst);
            animator().lock().set_working(true);
        }
        AgentEvent::RunFinished { status, .. } => {
            let left = (RUNS.fetch_sub(1, Ordering::SeqCst) - 1).max(0);
            RUNS.store(left, Ordering::SeqCst);
            let mut a = animator().lock();
            a.set_working(left > 0);
            if status == "done" {
                a.wave();
            }
        }
        AgentEvent::ApprovalRequested { .. } | AgentEvent::Question { .. } => animator().lock().wave(),
        _ => {}
    }
}

/// Start the animation thread (once).
pub fn start(app: &AppHandle, core: Arc<Core>) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("lumo-live-icon".into())
        .spawn(move || run(app, core))
        .map(|_| ())
        .unwrap_or_else(|e| log::warn!("live icon: {e}"));
}

fn run(app: AppHandle, core: Arc<Core>) {
    let t0 = Instant::now();
    let mut shown: Option<(Clip, usize)> = None;
    let mut cache: Vec<(Clip, usize, Image<'static>)> = Vec::new();
    loop {
        std::thread::sleep(TICK);
        if !core.settings().animated_icon {
            if shown.take().is_some() {
                restore(&app);
            }
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }
        let now = t0.elapsed().as_secs_f64();
        let next = animator().lock().tick(now, rand::random::<f64>());
        if shown == Some(next) {
            continue;
        }
        let (clip, i) = next;
        let png = clip_frames(clip)[i];
        let img = match cache.iter().find(|(c, n, _)| *c == clip && *n == i) {
            Some((_, _, img)) => img.clone(),
            None => match Image::from_bytes(png) {
                Ok(img) => {
                    cache.push((clip, i, img.clone()));
                    img
                }
                Err(e) => {
                    log::warn!("live icon frame: {e}");
                    continue;
                }
            },
        };
        show(&app, img, png);
        shown = Some(next);
    }
}

fn show(app: &AppHandle, img: Image<'static>, png: &'static [u8]) {
    if let Some(tray) = app.tray_by_id("lumo") {
        let _ = tray.set_icon(Some(img.clone()));
    }
    #[cfg(not(target_os = "macos"))]
    for label in ["main", "compact"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.set_icon(img.clone());
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = img;
        let _ = app.run_on_main_thread(move || dock::set(Some(png)));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = png;
}

/// Put the regular icons back (the user turned the animation off).
fn restore(app: &AppHandle) {
    if let Some(icon) = app.default_window_icon().cloned() {
        if let Some(tray) = app.tray_by_id("lumo") {
            let _ = tray.set_icon(Some(icon.clone()));
        }
        #[cfg(not(target_os = "macos"))]
        for label in ["main", "compact"] {
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.set_icon(icon.clone());
            }
        }
    }
    #[cfg(target_os = "macos")]
    let _ = app.run_on_main_thread(|| dock::set(None));
}

#[cfg(target_os = "macos")]
mod dock {
    use objc2::AnyThread;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    /// Set the Dock icon from PNG bytes, or back to the app's own icon with None. Main thread only.
    pub fn set(png: Option<&[u8]>) {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let app = NSApplication::sharedApplication(mtm);
        let image = png.and_then(|bytes| NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes)));
        unsafe { app.setApplicationIconImage(image.as_deref()) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_ticks(a: &mut Animator, from: f64, n: usize) -> Vec<(Clip, usize)> {
        (0..n).map(|i| a.tick(from + i as f64 * 0.08, 0.5)).collect()
    }

    #[test]
    fn every_frame_decodes() {
        for clip in [Clip::Idle, Clip::Blink, Clip::Work, Clip::Wave] {
            for png in clip_frames(clip) {
                let img = Image::from_bytes(png).expect("frame decodes");
                assert_eq!((img.width(), img.height()), (64, 64));
            }
        }
    }

    #[test]
    fn idle_holds_then_blinks() {
        let mut a = Animator::new(0.0);
        assert!(run_ticks(&mut a, 0.0, 20).iter().all(|f| *f == (Clip::Idle, 0)));
        let later = run_ticks(&mut a, BLINK_EVERY, BLINK.len() + 2);
        assert_eq!(later[0], (Clip::Blink, 0));
        assert_eq!(later[BLINK.len() - 1], (Clip::Blink, BLINK.len() - 1));
        assert_eq!(later[BLINK.len()], (Clip::Idle, 0));
    }

    #[test]
    fn works_in_a_loop_then_waves_once_when_done() {
        let mut a = Animator::new(0.0);
        a.set_working(true);
        let f = run_ticks(&mut a, 0.0, WORK.len() + 2);
        assert_eq!(f[0], (Clip::Work, 0));
        assert!(f.iter().all(|(c, _)| *c == Clip::Work));
        assert_eq!(f[WORK.len()], (Clip::Work, 0), "loops");
        a.set_working(false);
        a.wave();
        let f = run_ticks(&mut a, 2.0, WAVE.len() + 3);
        assert_eq!(f[0], (Clip::Wave, 0));
        assert_eq!(f[WAVE.len() - 1], (Clip::Wave, WAVE.len() - 1));
        assert_eq!(f[WAVE.len()], (Clip::Idle, 0));
    }
}
