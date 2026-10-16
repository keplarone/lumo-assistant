//! macOS: one fix from CoreLocation.
//!
//! A `CLLocationManager` delivers its delegate callbacks on the run loop of the thread that created
//! it, so each request gets its own short-lived thread that runs a run loop until a fix, an error or
//! the deadline. The first request shows the system's "Allow Lumo to use your location?" prompt
//! (worded by `NSLocationUsageDescription` in Info.plist).

use super::{Fix, FixError};
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_core_location::{
    kCLLocationAccuracyHundredMeters, CLAuthorizationStatus, CLError, CLLocation, CLLocationManager, CLLocationManagerDelegate,
};
use objc2_foundation::{NSArray, NSDate, NSDefaultRunLoopMode, NSError, NSObject, NSObjectProtocol, NSRunLoop};
use std::cell::RefCell;
use std::time::{Duration, Instant};

/// How long the user has to answer the system's permission prompt.
const PROMPT_WAIT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Ivars {
    outcome: RefCell<Option<Result<Fix, FixError>>>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class does not implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "LumoLocationDelegate"]
    #[ivars = Ivars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl CLLocationManagerDelegate for Delegate {
        #[unsafe(method(locationManager:didUpdateLocations:))]
        fn did_update_locations(&self, _manager: &CLLocationManager, locations: &NSArray<CLLocation>) {
            if let Some(loc) = locations.lastObject() {
                // SAFETY: plain property reads on a valid CLLocation.
                let (c, acc) = unsafe { (loc.coordinate(), loc.horizontalAccuracy()) };
                let accuracy_m = (acc.is_finite() && acc >= 0.0).then_some(acc);
                self.ivars().outcome.replace(Some(Ok(Fix { lat: c.latitude, lon: c.longitude, accuracy_m })));
            }
        }

        #[unsafe(method(locationManager:didFailWithError:))]
        fn did_fail_with_error(&self, _manager: &CLLocationManager, error: &NSError) {
            let code = error.code();
            // "Location unknown" is temporary: Core Location keeps trying until Lumo's deadline.
            if code == CLError::LocationUnknown.0 {
                return;
            }
            let e = if code == CLError::Denied.0 { FixError::Denied } else { FixError::Failed(format!("Core Location error {code}")) };
            self.ivars().outcome.replace(Some(Err(e)));
        }
    }
);

impl Delegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(Ivars::default());
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

pub(super) async fn position(timeout: Duration) -> Result<Fix, FixError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("lumo-location".into())
        .spawn(move || {
            let _ = tx.send(autoreleasepool(|_| locate(timeout)));
        })
        .map_err(|e| FixError::Failed(e.to_string()))?;
    rx.await.unwrap_or_else(|_| Err(FixError::Failed("the location request stopped".into())))
}

fn locate(timeout: Duration) -> Result<Fix, FixError> {
    // SAFETY: a class method with no arguments.
    if !unsafe { CLLocationManager::locationServicesEnabled_class() } {
        return Err(FixError::ServicesOff);
    }
    // SAFETY: CLLocationManager may be created on any thread that runs a run loop (this one does).
    let manager = unsafe { CLLocationManager::new() };
    let delegate = Delegate::new();
    // SAFETY: the delegate outlives every callback: it is detached below before it is dropped.
    unsafe {
        manager.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        manager.setDesiredAccuracy(kCLLocationAccuracyHundredMeters);
    }
    let result = run(&manager, &delegate, timeout);
    // SAFETY: stopping and detaching are always allowed.
    unsafe {
        manager.stopUpdatingLocation();
        manager.setDelegate(None);
    }
    result
}

fn run(manager: &CLLocationManager, delegate: &Delegate, timeout: Duration) -> Result<Fix, FixError> {
    let run_loop = NSRunLoop::currentRunLoop();
    let prompt_deadline = Instant::now() + PROMPT_WAIT;
    let mut asked = false;
    let mut fix_deadline: Option<Instant> = None;
    loop {
        if let Some(outcome) = delegate.ivars().outcome.take() {
            return outcome;
        }
        // SAFETY: a property read.
        let status = unsafe { manager.authorizationStatus() };
        if status == CLAuthorizationStatus::Denied || status == CLAuthorizationStatus::Restricted {
            return Err(FixError::Denied);
        }
        if status == CLAuthorizationStatus::NotDetermined {
            if !asked {
                // SAFETY: shows the system prompt; the answer arrives as a status change.
                unsafe { manager.requestWhenInUseAuthorization() };
                asked = true;
            }
            if Instant::now() > prompt_deadline {
                return Err(FixError::Timeout);
            }
        } else if fix_deadline.is_none() {
            // SAFETY: the delegate implements both callbacks requestLocation needs.
            unsafe { manager.requestLocation() };
            fix_deadline = Some(Instant::now() + timeout);
        }
        if fix_deadline.is_some_and(|d| Instant::now() > d) {
            return Err(FixError::Timeout);
        }
        let until = NSDate::dateWithTimeIntervalSinceNow(0.25);
        // SAFETY: NSDefaultRunLoopMode is an immutable framework constant.
        let ran = run_loop.runMode_beforeDate(unsafe { NSDefaultRunLoopMode }, &until);
        if !ran {
            // Nothing is attached to the run loop yet; don't spin.
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}
