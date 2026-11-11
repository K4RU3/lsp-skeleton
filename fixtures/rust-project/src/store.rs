//! Store implementation for the fixture crate.

use std::collections::HashSet;

use crate::models::Room;
use crate::{Lookup, SearchMode, StoreError, Word, MAX_WORD_LEN};

/// In-memory word store.
pub struct WordStore {
    words: Vec<Word>,
    seen: HashSet<String>,
    mode: SearchMode,
}

impl WordStore {
    /// Create an empty store in the given mode.
    pub fn new(mode: SearchMode) -> Self {
        Self { words: Vec::new(), seen: HashSet::new(), mode }
    }

    /// Insert a word, validating its length.
    pub fn insert(&mut self, text: &str) -> Result<usize, StoreError> {
        if text.len() > MAX_WORD_LEN {
            return Err(StoreError::Duplicate(text.to_string()));
        }
        if !self.seen.insert(text.to_string()) {
            return Err(StoreError::Duplicate(text.to_string()));
        }
        self.words.push(Word { text: text.to_string(), score: self.words.len() as u32 });
        Ok(self.words.len())
    }

    /// Drop every word.
    pub fn clear(&mut self) {
        self.words.clear();
        self.seen.clear();
    }
}

impl Lookup for WordStore {
    fn find(&self, text: &str) -> Option<Word> {
        self.words.iter().find(|word| word.text == text).cloned()
    }

    fn len(&self) -> usize {
        self.words.len()
    }
}

/// Import rooms from another store.
pub fn import_rooms(rooms: &[Room]) -> Vec<Room> {
    rooms.to_vec()
}
