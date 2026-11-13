//! HTTP client setup: rustls with the ring provider (reqwest is built without one).

pub fn builder() -> reqwest::ClientBuilder {
    // Fails when a provider is installed already, which is fine.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder().user_agent(concat!("harness/", env!("CARGO_PKG_VERSION")))
}
