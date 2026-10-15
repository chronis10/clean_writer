use pulldown_cmark::{html, Event, Options, Parser, Tag, TagEnd};
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
    pub page_starts: Vec<usize>,
    pub page_layout_version: u32,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow: Option<String>,
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
fn source_offset(original: &str, prepared: &str, offset: usize) -> usize {
    let mut prepared_start = 0;
    let mut original_start = 0;
    for (line, source) in prepared.split('\n').zip(original.split('\n')) {
        if offset <= prepared_start + line.len() {
            let added = line.len().saturating_sub(source.len());
            let local = offset
                .saturating_sub(prepared_start + added)
                .min(source.len());
            return original_start + source[..local].encode_utf16().count();
        }
        prepared_start += line.len() + 1;
        original_start += source.encode_utf16().count() + 1;
    }
    original.encode_utf16().count()
}

fn render_core(text: &str, virtual_breaks: &[usize]) -> Rendered {
    let callout = Regex::new(r"(?i)<blockquote>\n<p>(?:<span[^>]*>)*\[(?:</?span[^>]*>)*!(NOTE|TODO)(?:</?span[^>]*>)*\](?:</?span[^>]*>)*(?:\s*<br[^>]*>)?\s*").unwrap();
    let image_source = Regex::new(r"(?i)(<img\b[^>]*?\s)src\s*=").unwrap();
    let mut words = 0;
    let mut section_from = 0;
    let sections = text.split('\u{000c}').map(|section| {
        let base = section_from;
        section_from += section.encode_utf16().count() + 1;
        let mut output = String::new();
        let prepared = prepare_callouts(section);
        let mut depth = 0;
        let mut in_image = false;
        let events = Parser::new_ext(&prepared, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS).into_offset_iter().flat_map(|(event, span)| {
            if let Event::Text(ref value) | Event::Code(ref value) = event {
                words += value.split_whitespace().filter(|word| !matches!(*word, "[!NOTE]" | "[!TODO]")).count();
            }
            let mut result = Vec::with_capacity(2);
            if matches!(event, Event::Start(_)) {
                if depth == 0 {
                    let from = base + source_offset(section, &prepared, span.start);
                    let to = base + source_offset(section, &prepared, span.end);
                    result.push(Event::Html(format!("<div class=\"source-block\" data-source-from=\"{from}\" data-source-to=\"{to}\">\n").into()));
                }
                depth += 1;
            }
            let from = base + source_offset(section, &prepared, span.start);
            let to = base + source_offset(section, &prepared, span.end);
            // A manual page break is a layout boundary, including inside a
            // fenced block. Remove its synthetic parsing newline from code
            // text while keeping source ranges on both sides of the break.
            if !in_image && !virtual_breaks.is_empty() {
                if let Event::Text(ref value) = event {
                    let mut cursor = span.start;
                    let mut value_start = 0;
                    let mut source_start = from;
                    let mut chunks = Vec::new();
                    for (index, _) in value.match_indices('\n') {
                        let Some(relative) = prepared[cursor..span.end].find('\n') else { break };
                        let newline = cursor + relative;
                        let position = source_offset(section, &prepared, newline);
                        if virtual_breaks.contains(&position) {
                            chunks.push((value[value_start..index].to_owned(), source_start, base+position));
                            value_start=index+1;
                            source_start=base+position+1;
                        }
                        cursor=newline+1;
                    }
                    if !chunks.is_empty() {
                        chunks.push((value[value_start..].to_owned(),source_start,to));
                        for (text, start, end) in chunks {
                            if text.is_empty() { continue; }
                            result.push(Event::Html(format!("<span class=\"source-text\" data-source-from=\"{start}\" data-source-to=\"{end}\">").into()));
                            result.push(Event::Text(text.into()));
                            result.push(Event::Html("</span>".into()));
                        }
                        return result;
                    }
                }
            }
            let image_start = matches!(&event, Event::Start(Tag::Image { .. }));
            let image_end = matches!(&event, Event::End(TagEnd::Image));
            let text_span = !in_image && matches!(&event, Event::Text(_) | Event::Code(_));
            let atom = image_start || matches!(&event, Event::Rule | Event::TaskListMarker(_));
            if text_span || atom {
                result.push(Event::Html(format!("<span class=\"{}\" data-source-from=\"{from}\" data-source-to=\"{to}\">", if atom { "source-atom" } else { "source-text" }).into()));
            }
            if image_start { in_image = true; }
            let end = matches!(event, Event::End(_));
            result.push(match event {
                Event::SoftBreak | Event::HardBreak => Event::Html(format!("<br class=\"source-break\" data-source-from=\"{from}\" data-source-to=\"{to}\">\n").into()),
                other => other,
            });
            if text_span || (atom && !image_start) || image_end { result.push(Event::Html("</span>".into())); }
            if image_end { in_image = false; }
            if end {
                depth -= 1;
                if depth == 0 { result.push(Event::Html("</div>\n".into())); }
            }
            result
        });
        html::push_html(&mut output, events);
        output = image_source.replace_all(&output, "${1}data-image-source=").into_owned();
        callout.replace_all(&output, |caps: &regex::Captures| {
            let kind = caps[1].to_ascii_lowercase();
            format!("<blockquote class=\"callout {kind}\"><p><strong class=\"callout-label\">{}</strong><br>", if kind == "note" { "Note" } else { "To do" })
        }).into_owned()
    }).collect();
    Rendered {
        sections,
        words,
        flow: None,
    }
}

pub fn render(text: &str) -> Rendered {
    let mut rendered = render_core(text, &[]);
    if text.contains('\u{000c}') {
        // Collapse consecutive page breaks to one parsing newline, maintaining
        // a UTF-16 map back to the original file, including explicit blank pages.
        let mut canonical = String::new();
        let mut offsets = vec![0];
        let mut breaks = Vec::new();
        let mut original = 0;
        let mut chars = text.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '\u{000c}' {
                breaks.push(offsets.len() - 1);
                original += 1;
                while chars.peek() == Some(&'\u{000c}') {
                    chars.next();
                    original += 1;
                }
                canonical.push('\n');
                offsets.push(original);
            } else {
                canonical.push(ch);
                for _ in 0..ch.len_utf16() {
                    original += 1;
                    offsets.push(original);
                }
            }
        }
        let full = render_core(&canonical, &breaks).sections.remove(0);
        let attributes = Regex::new(r#"data-source-(from|to)="([0-9]+)""#).unwrap();
        rendered.flow = Some(
            attributes
                .replace_all(&full, |caps: &regex::Captures| {
                    let offset = caps[2].parse::<usize>().unwrap();
                    format!(
                        "data-source-{}=\"{}\"",
                        &caps[1],
                        offsets[offset.min(offsets.len() - 1)]
                    )
                })
                .into_owned(),
        );
    }
    rendered
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
        assert!(render("first\nsecond").sections[0]
            .contains("<br class=\"source-break\" data-source-from=\"5\""));
    }
    #[test]
    fn html_images_render_and_code_remains_literal() {
        let source = r#"<p align="center"> <img src="ssl-pretraining.png" alt="Raman self-supervised pretraining architecture" width="750"> </p>"#;
        let html = &render(source).sections[0];
        assert!(html.contains("<p align=\"center\">"));
        assert!(html.contains("data-image-source=\"ssl-pretraining.png\""));
        assert!(html.contains("width=\"750\""));
        assert!(!html.contains("<img src="));
        let fenced = render(&format!("```html\n{source}\n```"));
        assert!(fenced.sections[0].contains("&lt;p"));
        assert!(!fenced.sections[0].contains("<img"));
        let reordered = render("<IMG alt='Example' SRC='image.png' width='100'>");
        assert!(reordered.sections[0].contains("data-image-source='image.png'"));
    }
    #[test]
    fn rendered_blocks_map_to_original_utf16_source() {
        let text = "📝 Intro.\n\n```bash\ncommand\n```";
        let html = &render(text).sections[0];
        assert!(html.contains("data-source-from=\"0\" data-source-to=\"10\""));
        let start = text.find("```bash").unwrap();
        let offset = text[..start].encode_utf16().count();
        assert!(html.contains(&format!("data-source-from=\"{offset}\"")));
        assert!(html.contains("<pre><code class=\"language-bash\"><span class=\"source-text\""));
        assert!(html.contains(">command\n</span></code></pre>"));
        let note = "[!NOTE]\nRemember this\n\nAfter.";
        let html = &render(note).sections[0];
        assert!(html.contains("callout note"));
        let start = note.find("After.").unwrap();
        assert!(html.contains(&format!("data-source-from=\"{start}\"")));
    }
    #[test]
    fn manual_breaks_preserve_continued_fences_and_inline_formatting() {
        let source = "```bash\nfirst command\u{000c}\u{000c}\nsecond command\n```";
        let result = render(source);
        assert_eq!(result.sections.len(), 3);
        let full = result.flow.unwrap();
        assert_eq!(
            full.matches("<pre><code class=\"language-bash\">").count(),
            1
        );
        assert!(full.contains(">first command</span>"));
        assert!(full.contains(">\nsecond command\n</span>"));
        let offset = source[..source.find("\nsecond").unwrap()]
            .encode_utf16()
            .count();
        assert!(full.contains(&format!("data-source-from=\"{offset}\"")));
        let inline = render("**bold\u{000c}\u{000c}continued**").flow.unwrap();
        assert!(inline.contains("<strong>"));
        assert!(!inline.contains("**"));
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
