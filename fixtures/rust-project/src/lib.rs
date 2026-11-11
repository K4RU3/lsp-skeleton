//! Fixture crate for the Rust profile.
//!
//! Every item kind the skeleton must map appears here once.

pub mod models;
pub mod store;

use std::collections::HashMap;

/// How words are matched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    /// Exact match.
    Exact,
    /// Prefix match.
    Prefix,
    /// Fuzzy match within a distance.
    Fuzzy { max_distance: u8 },
}

/// A stored word plus its metadata.
#[derive(Debug, Clone)]
pub struct Word {
    /// 単語の本文。マルチバイトでも欠けないこと。
    pub text: String,
    pub score: u32,
}

/// Errors the store can return.
#[derive(Debug)]
pub enum StoreError {
    Empty,
    Duplicate(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Empty => write!(formatter, "empty"),
            StoreError::Duplicate(word) => write!(formatter, "duplicate: {word}"),
        }
    }
}

/// Anything that can answer a lookup.
pub trait Lookup {
    /// Find one word.
    fn find(&self, text: &str) -> Option<Word>;

    /// Number of stored words.
    fn len(&self) -> usize;

    /// Default implementation, overridden by the store.
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// A pair of words, used to show tuple structs.
pub struct WordPair(pub Word, pub Word);

/// A result alias.
pub type LookupResult = Result<Word, StoreError>;

/// Process-wide default mode.
pub static DEFAULT_MODE: SearchMode = SearchMode::Exact;

/// Maximum word length.
pub const MAX_WORD_LEN: usize = 64;

/// Concatenate two words with a separator.
pub fn join(left: &str, right: &str, separator: &str) -> String {
    format!("{left}{separator}{right}")
}

/// Build a lookup table of the words by length.
pub fn group_by_length(words: &[Word]) -> HashMap<usize, Vec<String>> {
    let mut grouped: HashMap<usize, Vec<String>> = HashMap::new();
    for word in words {
        grouped.entry(word.text.len()).or_default().push(word.text.clone());
    }
    grouped
}

macro_rules! assert_word {
    ($value:expr) => {
        assert!(!$value.text.is_empty());
    };
}

/// A trait object shorthand.
pub type SharedLookup = std::sync::Arc<dyn Lookup + Send + Sync>;

/// A module with a body (not a separate file).
pub mod inline {
    /// Inner constant.
    pub const INNER: u8 = 1;

    /// Inner function with a nested local.
    pub fn nested(value: u8) -> u8 {
        let doubled = value * 2;
        doubled
    }
}

/// A union, rare but valid.
pub union Bits {
    pub whole: u32,
    pub halves: [u16; 2],
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_works() {
        assert_eq!(join("a", "b", "-"), "a-b");
    }
}
