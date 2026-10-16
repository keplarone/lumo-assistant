//! Linux: one fix from GeoClue2 over the system D-Bus.
//!
//! GeoClue decides whether Lumo may have the location (through the desktop's location agent and
//! privacy settings). If GeoClue is not installed or not running, Lumo says so and the user types
//! their location instead.

use super::{Fix, FixError};
use futures_util::StreamExt;
use std::time::Duration;
use zbus::proxy::CacheProperties;
use zbus::zvariant::OwnedObjectPath;

/// Matches the desktop entry the Linux bundles install, which GeoClue's agent uses to name the app.
const DESKTOP_ID: &str = "lumo";
/// GCLUE_ACCURACY_LEVEL_STREET: Wi-Fi level, within the ~100 m Lumo keeps anyway.
const ACCURACY_STREET: u32 = 6;

#[zbus::proxy(
    interface = "org.freedesktop.GeoClue2.Manager",
    default_service = "org.freedesktop.GeoClue2",
    default_path = "/org/freedesktop/GeoClue2/Manager"
)]
trait Manager {
    fn get_client(&self) -> zbus::Result<OwnedObjectPath>;
}

#[zbus::proxy(interface = "org.freedesktop.GeoClue2.Client", default_service = "org.freedesktop.GeoClue2")]
trait Client {
    fn start(&self) -> zbus::Result<()>;
    fn stop(&self) -> zbus::Result<()>;
    #[zbus(property)]
    fn set_desktop_id(&self, value: &str) -> zbus::Result<()>;
    #[zbus(property)]
    fn set_requested_accuracy_level(&self, value: u32) -> zbus::Result<()>;
    #[zbus(signal)]
    fn location_updated(&self, old: OwnedObjectPath, new: OwnedObjectPath) -> zbus::Result<()>;
}

#[zbus::proxy(interface = "org.freedesktop.GeoClue2.Location", default_service = "org.freedesktop.GeoClue2")]
trait GeoLocation {
    #[zbus(property)]
    fn latitude(&self) -> zbus::Result<f64>;
    #[zbus(property)]
    fn longitude(&self) -> zbus::Result<f64>;
    #[zbus(property)]
    fn accuracy(&self) -> zbus::Result<f64>;
}

fn error_name(e: &zbus::Error) -> String {
    match e {
        zbus::Error::MethodError(name, _, _) => name.as_str().to_string(),
        zbus::Error::FDO(f) => zbus::DBusError::name(f.as_ref()).as_str().to_string(),
        _ => String::new(),
    }
}

fn map_err(e: zbus::Error) -> FixError {
    let name = error_name(&e);
    if name.ends_with(".ServiceUnknown") || name.ends_with(".NameHasNoOwner") || name.ends_with(".UnknownObject") {
        FixError::NotSupported
    } else if name.ends_with(".AccessDenied") {
        // GeoClue answers AccessDenied both when the user refused and when location is off.
        FixError::Denied
    } else {
        FixError::Failed(e.to_string())
    }
}

pub(super) async fn position(timeout: Duration) -> Result<Fix, FixError> {
    // No system bus (or no GeoClue on it) means no location service on this computer.
    let conn = zbus::Connection::system().await.map_err(|_| FixError::NotSupported)?;
    let manager = ManagerProxy::new(&conn).await.map_err(map_err)?;
    let client_path = manager.get_client().await.map_err(map_err)?;
    let client = ClientProxy::builder(&conn)
        .path(client_path)
        .map_err(map_err)?
        .cache_properties(CacheProperties::No)
        .build()
        .await
        .map_err(map_err)?;
    client.set_desktop_id(DESKTOP_ID).await.map_err(map_err)?;
    client.set_requested_accuracy_level(ACCURACY_STREET).await.map_err(map_err)?;
    let mut updates = client.receive_location_updated().await.map_err(map_err)?;
    client.start().await.map_err(map_err)?;
    let first = tokio::time::timeout(timeout, updates.next()).await;
    let _ = client.stop().await;
    let signal = match first {
        Ok(Some(s)) => s,
        Ok(None) => return Err(FixError::Failed("the location service stopped".into())),
        Err(_) => return Err(FixError::Timeout),
    };
    let args = signal.args().map_err(map_err)?;
    let loc = GeoLocationProxy::builder(&conn)
        .path(args.new.clone())
        .map_err(map_err)?
        .cache_properties(CacheProperties::No)
        .build()
        .await
        .map_err(map_err)?;
    let lat = loc.latitude().await.map_err(map_err)?;
    let lon = loc.longitude().await.map_err(map_err)?;
    let accuracy = loc.accuracy().await.ok().filter(|a| a.is_finite() && *a >= 0.0);
    Ok(Fix { lat, lon, accuracy_m: accuracy })
}
