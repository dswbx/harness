//! Writes the adapter's IPC types: `cargo run -p harness-tauri --example gen-host-ts -- <out.ts>`.

fn main() {
    let out = std::env::args().nth(1).expect("usage: gen-host-ts <out.ts>");
    std::fs::write(&out, harness_tauri::host_types::export_ts()).expect("write");
    println!("wrote {out}");
}
