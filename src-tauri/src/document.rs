use pulldown_cmark::{html, Event, Options, Parser};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path};

#[derive(Clone, Default, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Bookmark {
    pub id: String,
    pub offset: usize,
    pub title: String,
}
#[derive(Clone, Default, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Document {
    pub path: Option<String>,
    pub text: String,
    pub cursor: usize,
    pub bookmarks: Vec<Bookmark>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub document: Document,
    pub recent: Vec<String>,
    pub preferences: serde_json::Value,
}
impl Default for Session {
    fn default() -> Self {
        Self {
            document: Document::default(),
            recent: vec![],
            preferences: serde_json::json!({}),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendered {
    pub sections: Vec<String>,
    pub words: usize,
}

fn prepare_callouts(source: &str) -> String {
    let mut fence: Option<(char, usize)> = None;
    let mut callout = false;
    source
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            let marker = trimmed.chars().next().filter(|c| matches!(c, '`' | '~'));
            if let Some(ch) = marker {
                let count = trimmed.chars().take_while(|c| *c == ch).count();
                if count >= 3 {
                    if let Some((open, width)) = fence {
                        if ch == open && count >= width {
                            fence = None;
                        }
                    } else {
                        fence = Some((ch, count));
                    }
                    callout = false;
                    return line.to_owned();
                }
            }
            if fence.is_some() || line.starts_with("    ") || line.starts_with('\t') {
                return line.to_owned();
            }
            if trimmed.is_empty() {
                callout = false;
                return String::new();
            }
            if trimmed.starts_with("[!NOTE]") || trimmed.starts_with("[!TODO]") {
                callout = true;
            }
            if callout {
                format!("> {line}")
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}
pub fn render(text: &str) -> Rendered {
    let callout = Regex::new(r"(?i)<blockquote>\n<p>\[!(NOTE|TODO)\](?:\s*<br\s*/?>)?\s*").unwrap();
    let mut words = 0;
    let sections = text.split('\u{000c}').map(|section| {
        let mut output = String::new();
        let prepared = prepare_callouts(section);
        let events = Parser::new_ext(&prepared, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS).map(|event| {
            match event {
                Event::Text(ref value) | Event::Code(ref value) => {
                    words += value.split_whitespace().filter(|word| !matches!(*word, "[!NOTE]" | "[!TODO]")).count();
                }
                _ => {}
            }
            // Treat source HTML as literal text. Never execute user document HTML.
            match event { Event::SoftBreak => Event::HardBreak, Event::Html(value) | Event::InlineHtml(value) => Event::Text(value), other => other }
        });
        html::push_html(&mut output, events);
        output = output.replace("<img src=", "<img data-image-source=");
        callout.replace_all(&output, |caps: &regex::Captures| {
            let kind = caps[1].to_ascii_lowercase();
            format!("<blockquote class=\"callout {kind}\"><p><strong class=\"callout-label\">{}</strong><br>", kind.to_ascii_uppercase())
        }).into_owned()
    }).collect();
    Rendered { sections, words }
}

pub fn read_document(path: &Path) -> Result<String, String> {
    let metadata =
        fs::metadata(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    if metadata.len() > 20 * 1024 * 1024 {
        return Err("This file exceeds the 20 MB document limit.".into());
    }
    fs::read_to_string(path)
        .map_err(|e| format!("Cannot read UTF-8 document {}: {e}", path.display()))
}

// Stage in the same directory and replace only after data has been flushed.
// Failed writes retain the original destination and the persisted recovery copy.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    if let Ok(meta) = fs::metadata(path) {
        staged
            .as_file()
            .set_permissions(meta.permissions())
            .map_err(|e| e.to_string())?;
    }
    staged.write_all(bytes).map_err(|e| e.to_string())?;
    staged.as_file().sync_all().map_err(|e| e.to_string())?;
    staged
        .persist(path)
        .map_err(|e| format!("Cannot replace {}: {e}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn markdown_preserves_sections_and_formats_callouts() {
        let rendered = render("# Hello\n\n> [!NOTE]\n> Remember **this**.\n\n| A | B |\n| - | - |\n| x | y |\n\u{000c}\n- [x] Done");
        assert_eq!(rendered.sections.len(), 2);
        assert!(rendered.sections[0].contains("callout note"));
        assert!(rendered.sections[0].contains("<table>"));
        assert!(rendered.sections[1].contains("checked"));
        assert!(rendered.words > 3);
    }
    #[test]
    fn bare_callouts_do_not_change_code_examples() {
        let result = render("[!NOTE]\nRemember this\n\n```markdown\n[!TODO]\n```\n\n    [!NOTE]");
        assert_eq!(
            result.sections[0].matches("class=\"callout note\"").count(),
            1
        );
        assert!(!result.sections[0].contains("class=\"callout todo\""));
    }
    #[test]
    fn images_keep_inert_sources_and_alt_text() {
        let result=render("![A local photo](<images/photo one.png>)\n\n![Web photo](https://example.com/photo.jpg)");
        assert!(result.sections[0].contains("data-image-source=\"images/photo%20one.png\""));
        assert!(result.sections[0].contains("alt=\"A local photo\""));
        assert!(!result.sections[0].contains("<img src="));
    }
    #[test]
    fn line_breaks_are_preserved() {
        assert!(render("first\nsecond").sections[0].contains("<br />"));
    }
    #[test]
    fn html_is_literal() {
        assert!(!render("<script>alert(1)</script>").sections[0].contains("<script>"));
    }
    #[test]
    fn writes_replace_unicode_without_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        atomic_write(&path, b"original").unwrap();
        atomic_write(&path, "Ελληνικά 📝\u{000c}第二頁".as_bytes()).unwrap();
        assert_eq!(read_document(&path).unwrap(), "Ελληνικά 📝\u{000c}第二頁");
        assert!(atomic_write(&dir.path().join("missing/file.md"), b"lost").is_err());
        assert_eq!(read_document(&path).unwrap(), "Ελληνικά 📝\u{000c}第二頁");
    }
}
