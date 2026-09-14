//! Goldberg `achievements.json` parsing and unlock diffing (#8).
//!
//! The emulator writes achievement metadata and, at runtime, unlocks into its
//! `steam_settings` tree. This module turns that on-disk metadata into the
//! neutral shape Drop's achievement API stores, so `drop-gse` can post unlocks
//! to `POST /api/v1/client/achievements/unlock` without core knowing anything
//! about Goldberg.

use std::collections::HashSet;

use serde_json::Value;

use crate::error::EngineError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AchievementDefinition {
    pub key: String,
    pub name: String,
    pub description: String,
    pub hidden: bool,
}

/// Parses a Goldberg-family `achievements.json`. Accepts either an array of
/// achievement objects or an object keyed by achievement id.
pub fn parse_achievements(json: &str) -> Result<Vec<AchievementDefinition>, EngineError> {
    let value: Value = serde_json::from_str(json)?;
    let mut parsed = Vec::new();
    match &value {
        Value::Array(items) => {
            for item in items {
                if let Some(definition) = definition_from_value(item, None) {
                    parsed.push(definition);
                }
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                if let Some(definition) = definition_from_value(item, Some(key)) {
                    parsed.push(definition);
                }
            }
        }
        _ => {}
    }
    Ok(parsed)
}

fn definition_from_value(
    value: &Value,
    fallback_key: Option<&str>,
) -> Option<AchievementDefinition> {
    let object = value.as_object()?;

    let key = object
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| object.get("id").and_then(Value::as_str))
        .or(fallback_key)?
        .to_string();

    let name = localized_string(object.get("displayName")).unwrap_or_else(|| key.clone());
    let description = localized_string(object.get("description")).unwrap_or_default();
    let hidden = match object.get("hidden") {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_i64().unwrap_or(0) != 0,
        _ => false,
    };

    Some(AchievementDefinition {
        key,
        name,
        description,
        hidden,
    })
}

fn localized_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Object(map) => map
            .get("english")
            .or_else(|| map.values().next())
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

/// Returns the ids in `reported` that are not already in `known`.
#[must_use]
pub fn newly_unlocked(known: &HashSet<String>, reported: &[String]) -> Vec<String> {
    reported
        .iter()
        .filter(|id| !known.contains(*id))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_array_with_localized_names() {
        let json = r#"[
            {
                "name": "ACH_FIRST_BLOOD",
                "displayName": { "english": "First Blood" },
                "description": { "english": "Win your first match" },
                "hidden": 0
            },
            {
                "name": "ACH_SECRET",
                "displayName": "Secret",
                "hidden": 1
            }
        ]"#;

        let parsed = parse_achievements(json).expect("valid json");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].key, "ACH_FIRST_BLOOD");
        assert_eq!(parsed[0].name, "First Blood");
        assert_eq!(parsed[0].description, "Win your first match");
        assert!(!parsed[0].hidden);
        assert!(parsed[1].hidden);
    }

    #[test]
    fn parses_an_object_map_keyed_by_id() {
        let json = r#"{
            "ACH_A": { "displayName": "A", "description": "First" },
            "ACH_B": { "displayName": "B", "hidden": true }
        }"#;
        let parsed = parse_achievements(json).expect("valid json");
        assert_eq!(parsed.len(), 2);
        assert!(parsed.iter().any(|a| a.key == "ACH_A"));
    }

    #[test]
    fn ignores_entries_without_an_id() {
        let json = r#"[{ "displayName": "no id" }, { "name": "ok" }]"#;
        let parsed = parse_achievements(json).expect("valid json");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].key, "ok");
    }

    #[test]
    fn diffs_new_unlocks() {
        let known: HashSet<String> = ["ACH_A".to_string()].into_iter().collect();
        let reported = vec![
            "ACH_A".to_string(),
            "ACH_B".to_string(),
            "ACH_C".to_string(),
        ];
        assert_eq!(newly_unlocked(&known, &reported), vec!["ACH_B", "ACH_C"]);
    }
}
