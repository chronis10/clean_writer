use crate::dictionary_packs::DictionaryStore;
use spellbook::Dictionary;
use std::sync::OnceLock;
use tauri::State;
use unicode_normalization::UnicodeNormalization;

// Compile the data into every platform's executable. Installed apps never need
// to find a dictionary on disk or download a language pack.
struct Dictionaries {
    english: Dictionary,
    greek: Dictionary,
}
static DICTIONARIES: OnceLock<Result<Dictionaries, String>> = OnceLock::new();

fn dictionaries() -> Result<&'static Dictionaries, String> {
    DICTIONARIES
        .get_or_init(|| {
            Ok(Dictionaries {
                english: Dictionary::new(
                    include_str!("../dictionaries/en_US.aff"),
                    include_str!("../dictionaries/en_US.dic"),
                )
                .map_err(|error| format!("Bundled English dictionary: {error}"))?,
                greek: Dictionary::new(
                    include_str!("../dictionaries/el_GR.aff"),
                    include_str!("../dictionaries/el_GR.dic"),
                )
                .map_err(|error| format!("Bundled Greek dictionary: {error}"))?,
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn normalized_word(word: &str) -> Option<String> {
    if word.len() > 400 || word.chars().count() < 2 {
        return None;
    }
    let word: String = word.nfc().collect();
    word.chars()
        .all(|c| c.is_alphabetic() || c == '\'' || c == '’')
        .then_some(word)
}

impl Dictionaries {
    fn correct(&self, word: &str) -> bool {
        self.english.check(word) || self.greek.check(word)
    }

    fn suggest(&self, word: &str) -> Vec<String> {
        if self.correct(word) {
            return Vec::new();
        }
        let greek = word.chars().any(|c| {
            ('\u{0370}'..='\u{03ff}').contains(&c) || ('\u{1f00}'..='\u{1fff}').contains(&c)
        });
        let mut suggestions = Vec::new();
        let dictionary = if greek { &self.greek } else { &self.english };
        dictionary.suggest(word, &mut suggestions);
        suggestions.dedup();
        suggestions.truncate(5);
        suggestions
    }
}

pub fn warm_up() {
    tauri::async_runtime::spawn_blocking(|| {
        let _ = dictionaries();
    });
}

#[tauri::command]
pub async fn spelling_suggestions(
    word: String,
    store: State<'_, DictionaryStore>,
) -> Result<Vec<String>, String> {
    let Some(word) = normalized_word(&word) else {
        return Ok(Vec::new());
    };
    let installed = store.loaded.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let installed = installed.read().map_err(|e| e.to_string())?;
        let bundled = dictionaries()?;
        if bundled.correct(&word) || installed.values().any(|dictionary| dictionary.check(&word)) {
            return Ok(Vec::new());
        }
        let mut suggestions = bundled.suggest(&word);
        for dictionary in installed.values() {
            let mut additional = Vec::new();
            dictionary.suggest(&word, &mut additional);
            suggestions.extend(additional);
        }
        suggestions.sort_by_key(|suggestion| {
            edit_distance(&word.to_lowercase(), &suggestion.to_lowercase())
        });
        let mut seen = std::collections::HashSet::new();
        suggestions.retain(|suggestion| seen.insert(suggestion.clone()));
        suggestions.truncate(5);
        Ok(suggestions)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn spelling_misspellings(
    words: Vec<String>,
    store: State<'_, DictionaryStore>,
) -> Result<Vec<String>, String> {
    if words.len() > 512 {
        return Err("Too many words in a spell-check batch".into());
    }
    let installed = store.loaded.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let installed = installed.read().map_err(|e| e.to_string())?;
        let dictionary = dictionaries()?;
        Ok(words
            .into_iter()
            .filter_map(|word| normalized_word(&word))
            .filter(|word| {
                !dictionary.correct(word)
                    && !installed.values().any(|dictionary| dictionary.check(word))
            })
            .collect())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, a) in a.chars().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, b) in b.iter().enumerate() {
            let previous = row[j + 1];
            row[j + 1] = (diagonal + usize::from(a != *b))
                .min(row[j] + 1)
                .min(previous + 1);
            diagonal = previous;
        }
    }
    row[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_dictionaries_work_without_system_dictionaries() {
        let dictionary = dictionaries().unwrap();
        assert!(dictionary.correct("hello"));
        assert!(dictionary.correct("καλημέρα"));
        assert!(dictionary.suggest("teh").contains(&"the".into()));
        assert!(dictionary.suggest("καλημέρρα").contains(&"καλημέρα".into()));
        assert!(dictionary.suggest("hello").is_empty());
        assert!(dictionary.suggest("καλημέρα").is_empty());
    }

    #[test]
    fn accented_words_are_normalized_and_non_words_are_ignored() {
        assert_eq!(normalized_word("καλημε\u{0301}ρα"), Some("καλημέρα".into()));
        assert!(normalized_word("hello\nworld").is_none());
        assert!(normalized_word(&"a".repeat(401)).is_none());
    }
}
