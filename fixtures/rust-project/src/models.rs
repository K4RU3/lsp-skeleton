//! Data model of the fixture crate.

use std::collections::HashMap;

pub use crate::SearchMode;

/// One room of the game.
#[derive(Debug, Default)]
pub struct Room {
    pub id: u64,
    pub name: Option<String>,
    pub words: Vec<String>,
}

impl Room {
    /// Create an empty room.
    pub fn new(id: u64) -> Self {
        Self { id, name: None, words: Vec::new() }
    }

    /// Add a word, rejecting duplicates.
    pub fn add_word(&mut self, word: String) -> Result<(), super::StoreError> {
        if self.words.contains(&word) {
            return Err(super::StoreError::Duplicate(word));
        }
        self.words.push(word);
        Ok(())
    }

    /// Words grouped by their first character.
    pub fn by_first(&self) -> HashMap<char, usize> {
        let mut counts = HashMap::new();
        for word in &self.words {
            if let Some(first) = word.chars().next() {
                *counts.entry(first).or_insert(0) += 1;
            }
        }
        counts
    }
}

impl Default for Room {

    fn default() -> Self {
        Room::new(0)
    }
}
