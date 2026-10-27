//! Writes the TS API types: `cargo run -p harness-core --bin gen-ts -- <out.ts>`.

fn main() {
    let out = std::env::args().nth(1).expect("usage: gen-ts <out.ts>");
    std::fs::write(&out, harness_core::api::export_ts()).expect("write");
    println!("wrote {out}");
}
