// sqlx::migrate! embeds the migrations at compile time; this makes Cargo rebuild when one is
// added or changed, so a local binary never runs with a stale migration list.
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
