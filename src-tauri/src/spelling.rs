use spellbook::Dictionary;
use std::sync::OnceLock;
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
pub async fn spelling_suggestions(word: String) -> Result<Vec<String>, String> {
    let Some(word) = normalized_word(&word) else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || Ok(dictionaries()?.suggest(&word)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn spelling_misspellings(words: Vec<String>) -> Result<Vec<String>, String> {
    if words.len() > 512 {
        return Err("Too many words in a spell-check batch".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dictionary = dictionaries()?;
        Ok(words
            .into_iter()
            .filter_map(|word| normalized_word(&word))
            .filter(|word| !dictionary.correct(word))
            .collect())
    })
    .await
    .map_err(|error| error.to_string())?
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
