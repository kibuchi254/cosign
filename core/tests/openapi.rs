//! The OpenAPI document must describe every route the router serves, so the generated
//! Python and TypeScript clients cannot drift from the code.

#[test]
fn every_route_is_documented() {
    let src = include_str!("../src/api.rs");
    let doc: serde_json::Value = serde_json::from_str(cosign_core::api::OPENAPI).expect("openapi.json is valid JSON");
    let paths = doc["paths"].as_object().expect("paths");
    let routes: Vec<&str> = src.match_indices(".route(\"").map(|(i, _)| { let rest = &src[i + 8..]; &rest[..rest.find('"').unwrap()] }).collect();
    assert!(routes.len() > 20);
    for r in &routes {
        if *r == "/openapi.json" { continue; }
        assert!(paths.contains_key(*r), "{r} is served but missing from core/openapi.json");
    }
    for p in paths.keys() {
        assert!(routes.contains(&p.as_str()), "{p} is documented but not served");
    }
}
