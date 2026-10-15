use encoding_rs::Encoding;
use serde::{Deserialize, Serialize};
use spellbook::Dictionary;
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, RwLock},
    time::Duration,
};
use tauri::State;

#[derive(Deserialize, Serialize)]
struct Catalog {
    revision: String,
    languages: Vec<Language>,
}
#[derive(Deserialize, Serialize)]
struct Language {
    code: String,
    name: String,
    stem: String,
    licenses: Vec<String>,
}
fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../dictionaries/catalog.json"))
            .expect("valid bundled dictionary catalog")
    })
}

#[derive(Serialize)]
pub struct DictionaryInfo {
    code: String,
    name: String,
    installed: bool,
    bundled: bool,
}

pub struct DictionaryStore {
    root: PathBuf,
    pub loaded: Arc<RwLock<BTreeMap<String, Dictionary>>>,
    installing: Mutex<HashSet<String>>,
}
impl DictionaryStore {
    pub fn load(root: PathBuf) -> Self {
        let mut loaded = BTreeMap::new();
        for language in &catalog().languages {
            let dir = root.join(&language.code);
            if !dir.exists() {
                continue;
            }
            match read_pair(&dir, &language.code) {
                Ok(dictionary) => {
                    loaded.insert(language.code.clone(), dictionary);
                }
                Err(error) => eprintln!("Cannot load {} dictionary: {error}", language.code),
            }
        }
        Self {
            root,
            loaded: Arc::new(RwLock::new(loaded)),
            installing: Mutex::new(HashSet::new()),
        }
    }
    fn list(&self) -> Result<Vec<DictionaryInfo>, String> {
        let loaded = self.loaded.read().map_err(|e| e.to_string())?;
        let mut result = vec![
            DictionaryInfo {
                code: "en_US".into(),
                name: "English (US)".into(),
                installed: true,
                bundled: true,
            },
            DictionaryInfo {
                code: "el_GR".into(),
                name: "Greek".into(),
                installed: true,
                bundled: true,
            },
        ];
        result.extend(catalog().languages.iter().map(|language| DictionaryInfo {
            code: language.code.clone(),
            name: language.name.clone(),
            installed: loaded.contains_key(&language.code),
            bundled: false,
        }));
        result.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(result)
    }
}

fn read_pair(dir: &Path, code: &str) -> Result<Dictionary, String> {
    let aff = fs::read_to_string(dir.join(format!("{code}.aff"))).map_err(|e| e.to_string())?;
    let dic = fs::read_to_string(dir.join(format!("{code}.dic"))).map_err(|e| e.to_string())?;
    Dictionary::new(&aff, &dic).map_err(|e| e.to_string())
}

// Match the bundled Greek conversion: decode both files using SET, then save
// lossless UTF-8 with an updated SET directive. Keep all affixes and words.
fn utf8_pair(aff: &[u8], dic: &[u8]) -> Result<(String, String), String> {
    let header = String::from_utf8_lossy(aff);
    let label = header
        .lines()
        .find_map(|line| {
            let mut words = line.trim_start_matches('\u{feff}').split_whitespace();
            (words.next() == Some("SET"))
                .then(|| words.next())
                .flatten()
        })
        .ok_or("Dictionary is missing its SET encoding directive")?;
    let encoding = Encoding::for_label(label.as_bytes())
        .ok_or_else(|| format!("Unsupported dictionary encoding: {label}"))?;
    let decode = |bytes: &[u8]| {
        encoding
            .decode_without_bom_handling_and_without_replacement(bytes)
            .map(|s| s.into_owned())
            .ok_or_else(|| format!("Invalid {label} dictionary data"))
    };
    let aff = decode(aff)?;
    let dic = decode(dic)?.trim_start_matches('\u{feff}').to_owned();
    if dic
        .lines()
        .next()
        .and_then(|n| n.trim().parse::<usize>().ok())
        .is_none()
    {
        return Err("Dictionary word list is missing its word count".into());
    }
    let aff = aff
        .lines()
        .map(|line| {
            if line
                .trim_start_matches('\u{feff}')
                .split_whitespace()
                .next()
                == Some("SET")
            {
                "SET UTF-8"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    Ok((aff, dic))
}

async fn download(client: &reqwest::Client, path: &str) -> Result<Vec<u8>, String> {
    let url = format!(
        "https://raw.githubusercontent.com/LibreOffice/dictionaries/{}/{path}",
        catalog().revision
    );
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Download failed: {e}"))?;
    const LIMIT: usize = 32 * 1024 * 1024;
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err("Dictionary download exceeds 32 MB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > LIMIT {
            return Err("Dictionary download exceeds 32 MB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err("Dictionary download was empty".into());
    }
    Ok(bytes)
}

struct Pack {
    aff: Vec<u8>,
    dic: Vec<u8>,
    licenses: Vec<(String, Vec<u8>)>,
}
async fn download_pack(language: &Language) -> Result<Pack, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent("Clean-Writer dictionary installer")
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let aff = download(&client, &format!("{}.aff", language.stem)).await?;
    let dic = download(&client, &format!("{}.dic", language.stem)).await?;
    let mut licenses = Vec::new();
    for path in &language.licenses {
        let name = Path::new(path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        licenses.push((name, download(&client, path).await?));
    }
    Ok(Pack { aff, dic, licenses })
}

fn install_pack(store: &DictionaryStore, language: &Language, pack: Pack) -> Result<(), String> {
    let (aff, dic) = utf8_pair(&pack.aff, &pack.dic)?;
    let dictionary = Dictionary::new(&aff, &dic)
        .map_err(|e| format!("This dictionary could not be loaded: {e}"))?;
    // No installed state or active dictionary changes until every file is valid.
    fs::create_dir_all(&store.root).map_err(|e| e.to_string())?;
    let stage = tempfile::tempdir_in(&store.root).map_err(|e| e.to_string())?;
    fs::write(stage.path().join(format!("{}.aff", language.code)), aff)
        .map_err(|e| e.to_string())?;
    fs::write(stage.path().join(format!("{}.dic", language.code)), dic)
        .map_err(|e| e.to_string())?;
    let licenses = stage.path().join("licenses");
    fs::create_dir(&licenses).map_err(|e| e.to_string())?;
    for (name, bytes) in pack.licenses {
        fs::write(licenses.join(name), bytes).map_err(|e| e.to_string())?;
    }
    let source = serde_json::json!({"repository":"https://github.com/LibreOffice/dictionaries", "revision":catalog().revision, "language":language, "modification":"Converted to UTF-8 and updated SET; no word-list changes."});
    fs::write(
        stage.path().join("source.json"),
        serde_json::to_vec_pretty(&source).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let destination = store.root.join(&language.code);
    let mut loaded = store.loaded.write().map_err(|e| e.to_string())?;
    if loaded.contains_key(&language.code) {
        return Ok(());
    }
    // A previously damaged installation is retained until the new pair is ready.
    let backup = tempfile::tempdir_in(&store.root).map_err(|e| e.to_string())?;
    let previous = backup.path().join("previous");
    if destination.exists() {
        fs::rename(&destination, &previous).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(stage.path(), &destination) {
        if previous.exists() {
            let _ = fs::rename(&previous, &destination);
        }
        return Err(error.to_string());
    }
    loaded.insert(language.code.clone(), dictionary);
    Ok(())
}

#[tauri::command]
pub fn spelling_dictionaries(
    store: State<'_, DictionaryStore>,
) -> Result<Vec<DictionaryInfo>, String> {
    store.list()
}

#[tauri::command]
pub async fn install_spelling_dictionary(
    code: String,
    store: State<'_, DictionaryStore>,
) -> Result<Vec<DictionaryInfo>, String> {
    let language = catalog()
        .languages
        .iter()
        .find(|language| language.code == code)
        .ok_or("Unknown dictionary language")?;
    if store
        .loaded
        .read()
        .map_err(|e| e.to_string())?
        .contains_key(&code)
    {
        return store.list();
    }
    if !store
        .installing
        .lock()
        .map_err(|e| e.to_string())?
        .insert(code.clone())
    {
        return Err("This dictionary is already being installed".into());
    }
    let result = async {
        let pack = download_pack(language).await?;
        let root = store.root.clone();
        let loaded = store.loaded.clone();
        tauri::async_runtime::spawn_blocking(move || {
            install_pack(
                &DictionaryStore {
                    root,
                    loaded,
                    installing: Mutex::default(),
                },
                language,
                pack,
            )
        })
        .await
        .map_err(|e| e.to_string())??;
        store.list()
    }
    .await;
    store
        .installing
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&code);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pack() -> Pack {
        Pack {
            aff: b"SET ISO8859-1\n".to_vec(),
            dic: b"1\ncaf\xe9\n".to_vec(),
            licenses: vec![("LICENSE.txt".into(), b"Test license".to_vec())],
        }
    }
    #[test]
    fn installs_normalized_pairs_and_reloads_them_offline() {
        let temp = tempfile::tempdir().unwrap();
        let store = DictionaryStore::load(temp.path().join("dictionaries"));
        let language = &catalog().languages[0];
        install_pack(&store, language, pack()).unwrap();
        assert!(store.loaded.read().unwrap()[&language.code].check("café"));
        let dir = store.root.join(&language.code);
        assert_eq!(
            fs::read_to_string(dir.join(format!("{}.aff", language.code))).unwrap(),
            "SET UTF-8\n"
        );
        assert!(dir.join("licenses/LICENSE.txt").exists());
        assert!(dir.join("source.json").exists());
        let reloaded = DictionaryStore::load(store.root.clone());
        assert!(reloaded.loaded.read().unwrap()[&language.code].check("café"));
        assert!(
            reloaded
                .list()
                .unwrap()
                .iter()
                .find(|item| item.code == language.code)
                .unwrap()
                .installed
        );
    }
    #[test]
    fn failed_validation_preserves_existing_dictionaries_and_leaves_no_partial_pair() {
        let temp = tempfile::tempdir().unwrap();
        let store = DictionaryStore::load(temp.path().join("dictionaries"));
        let language = &catalog().languages[0];
        install_pack(&store, language, pack()).unwrap();
        let bad = Pack {
            aff: b"SET UTF-8\n".to_vec(),
            dic: b"<html>Error</html>".to_vec(),
            licenses: vec![],
        };
        assert!(install_pack(&store, &catalog().languages[1], bad).is_err());
        assert!(!store.root.join(&catalog().languages[1].code).exists());
        assert!(store.loaded.read().unwrap()[&language.code].check("café"));
        assert!(utf8_pair(b"SET UTF-8\n", b"1\ncaf\xe9").is_err());
    }
    #[test]
    fn repairs_damaged_pair_after_download_validation() {
        let temp = tempfile::tempdir().unwrap();
        let language = &catalog().languages[0];
        fs::create_dir_all(temp.path().join(&language.code)).unwrap();
        fs::write(
            temp.path()
                .join(&language.code)
                .join(format!("{}.aff", language.code)),
            "broken",
        )
        .unwrap();
        let store = DictionaryStore::load(temp.path().into());
        install_pack(&store, language, pack()).unwrap();
        assert!(read_pair(&store.root.join(&language.code), &language.code)
            .unwrap()
            .check("café"));
    }
    #[test]
    #[ignore = "Downloads all catalog entries from the official pinned source"]
    fn official_catalog_downloads_and_loads() {
        tauri::async_runtime::block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let store = DictionaryStore::load(temp.path().join("dictionaries"));
            for language in &catalog().languages {
                eprintln!("Checking {}", language.name);
                let pack = download_pack(language).await.unwrap();
                install_pack(&store, language, pack).unwrap();
            }
            assert_eq!(
                DictionaryStore::load(store.root)
                    .loaded
                    .read()
                    .unwrap()
                    .len(),
                catalog().languages.len()
            );
        });
    }
}
