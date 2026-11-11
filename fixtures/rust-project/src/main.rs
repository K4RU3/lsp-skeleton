use fixture_crate::models::Room;
use fixture_crate::store::WordStore;

use fixture_crate::{join, Lookup, SearchMode, DEFAULT_MODE};

/// Seconds between saves.
const SAVE_INTERVAL_SECS: u64 = 60;

/// Path of the data file.
fn data_path() -> String {
    let dir = std::env::var("DATA_DIR").unwrap_or_else(|_| "./data".to_string());
    format!("{dir}/data.json")
}

#[tokio::main]
async fn main() {
    let path = data_path();
    let mut store = WordStore::new(DEFAULT_MODE);
    let room = Room::new(1);
    store.insert("apple").expect("insert failed");
    let word = store.find("apple");
    if let Some(word) = word {
        println!("found {} in {} ({})", word.text, room.id, path);
    }
    let mode = SearchMode::Exact;
    match mode {
        SearchMode::Exact => println!("exact"),
        _ => println!("other"),
    }
    let _ = join("a", "b", "-");
    println!("every {SAVE_INTERVAL_SECS} seconds");
}
