//! Windows: one fix from `Windows.Devices.Geolocation.Geolocator`.
//!
//! Windows decides through Settings → Privacy & security → Location ("Let desktop apps access your
//! location"). The WinRT calls block, so they run on a blocking thread.

use super::{Fix, FixError};
use std::time::Duration;
use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator, PositionAccuracy, PositionStatus};
use windows::Foundation::TimeSpan;

/// E_ACCESSDENIED
const E_ACCESSDENIED: i32 = 0x8007_0005_u32 as i32;
/// HRESULT_FROM_WIN32(ERROR_TIMEOUT)
const E_TIMEOUT: i32 = 0x8007_05B4_u32 as i32;
/// A cached position this recent is good enough.
const MAX_AGE: Duration = Duration::from_secs(60);

pub(super) async fn position(timeout: Duration) -> Result<Fix, FixError> {
    tokio::task::spawn_blocking(move || locate(timeout)).await.map_err(|e| FixError::Failed(e.to_string()))?
}

fn ticks(d: Duration) -> TimeSpan {
    // TimeSpan counts 100-nanosecond intervals.
    TimeSpan { Duration: i64::try_from(d.as_nanos() / 100).unwrap_or(i64::MAX) }
}

fn failed(e: windows::core::Error) -> FixError {
    if e.code().0 == E_ACCESSDENIED {
        FixError::Denied
    } else if e.code().0 == E_TIMEOUT {
        FixError::Timeout
    } else {
        FixError::Failed(e.message())
    }
}

fn locate(timeout: Duration) -> Result<Fix, FixError> {
    let access = Geolocator::RequestAccessAsync().and_then(|op| op.join()).map_err(failed)?;
    if access == GeolocationAccessStatus::Denied {
        return Err(FixError::Denied);
    }
    let locator = Geolocator::new().map_err(failed)?;
    let _ = locator.SetDesiredAccuracy(PositionAccuracy::Default);
    match locator.GetGeopositionAsyncWithAgeAndTimeout(ticks(MAX_AGE), ticks(timeout)).and_then(|op| op.join()) {
        Ok(pos) => {
            let coord = pos.Coordinate().map_err(failed)?;
            let p = coord.Point().and_then(|pt| pt.Position()).map_err(failed)?;
            let accuracy = coord.Accuracy().ok().filter(|a| a.is_finite() && *a >= 0.0);
            Ok(Fix { lat: p.Latitude, lon: p.Longitude, accuracy_m: accuracy })
        }
        Err(e) => Err(match locator.LocationStatus() {
            // Disabled: the user turned off location for the computer or for desktop apps.
            Ok(PositionStatus::Disabled) => FixError::Denied,
            Ok(PositionStatus::NotAvailable) => FixError::NotSupported,
            _ => failed(e),
        }),
    }
}
