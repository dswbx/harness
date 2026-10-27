fn main() {
    app_lib::api::export_ts(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/generated.ts"));
    println!("wrote src/generated.ts");
}
