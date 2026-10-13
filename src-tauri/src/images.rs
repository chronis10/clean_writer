use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use serde::Serialize;
use std::{
    fs::File,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_BYTES: usize = 16 * 1024 * 1024;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedImage {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

pub fn local_path(source: &str, document: Option<&Path>) -> Result<PathBuf, String> {
    // Absolute Windows paths must be recognized before interpreting URI schemes.
    let path = Path::new(source);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    if let Ok(url) = tauri::Url::parse(source) {
        return if url.scheme() == "file" {
            url.to_file_path()
                .map_err(|_| "Invalid local image URL.".into())
        } else {
            Err("Use a local image path or an HTTP/HTTPS URL.".into())
        };
    }
    let parent = document
        .and_then(Path::parent)
        .ok_or("Save the document first to resolve relative image paths, or use Insert image….")?;
    let base = tauri::Url::from_directory_path(parent)
        .map_err(|_| "Cannot resolve the document directory.")?;
    let resolved = base.join(source).map_err(|e| e.to_string())?;
    resolved
        .to_file_path()
        .map_err(|_| "Invalid relative image path.".into())
}
pub fn decode(bytes: &[u8]) -> Result<LoadedImage, String> {
    if bytes.len() > MAX_BYTES {
        return Err("Image exceeds the 16 MB limit.".into());
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| format!("Cannot decode image (PNG, JPEG, GIF, WebP, or BMP): {e}"))?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut decoded = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    decoded.apply_orientation(orientation);
    let decoded = if decoded.width() > 2400 || decoded.height() > 2400 {
        decoded.resize(2400, 2400, image::imageops::FilterType::Lanczos3)
    } else {
        decoded
    };
    let mut output = Cursor::new(Vec::new());
    decoded
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(LoadedImage {
        data_url: format!(
            "data:image/png;base64,{}",
            STANDARD.encode(output.into_inner())
        ),
        width: decoded.width(),
        height: decoded.height(),
    })
}
pub async fn load(source: String, document: Option<PathBuf>) -> Result<LoadedImage, String> {
    let remote =
        tauri::Url::parse(&source).is_ok_and(|url| matches!(url.scheme(), "http" | "https"));
    let bytes = if remote {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("Clean-Writer/2.0")
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|e| e.to_string())?;
        let mut response = client
            .get(&source)
            .send()
            .await
            .map_err(|e| format!("Cannot download image: {e}"))?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        if response
            .content_length()
            .is_some_and(|size| size > MAX_BYTES as u64)
        {
            return Err("Image exceeds the 16 MB limit.".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > MAX_BYTES {
                return Err("Image exceeds the 16 MB limit.".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        bytes
    } else if source.starts_with("data:image/") {
        let (header, data) = source.split_once(',').ok_or("Invalid embedded image.")?;
        if !header.ends_with(";base64") || data.len() > MAX_BYTES * 4 / 3 + 4 {
            return Err("Invalid or oversized embedded image.".into());
        }
        STANDARD.decode(data).map_err(|e| e.to_string())?
    } else {
        let path = local_path(&source, document.as_deref())?;
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
            let metadata =
                std::fs::metadata(&path).map_err(|e| format!("Cannot open image: {e}"))?;
            if !metadata.is_file() {
                return Err("Image path is not a regular file.".into());
            }
            if metadata.len() > MAX_BYTES as u64 {
                return Err("Image exceeds the 16 MB limit.".into());
            }
            let file = File::open(path).map_err(|e| format!("Cannot open image: {e}"))?;
            let mut bytes = Vec::new();
            file.take((MAX_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > MAX_BYTES {
                return Err("Image exceeds the 16 MB limit.".into());
            }
            Ok(bytes)
        })
        .await
        .map_err(|e| e.to_string())??
    };
    tauri::async_runtime::spawn_blocking(move || decode(&bytes))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_relative_encoded_absolute_and_file_urls() {
        let dir = tempfile::tempdir().unwrap();
        let document = dir.path().join("notes.md");
        assert_eq!(
            local_path("images/photo%20one.png", Some(&document)).unwrap(),
            dir.path().join("images/photo one.png")
        );
        let absolute = dir.path().join("photo.png");
        let url = tauri::Url::from_file_path(&absolute).unwrap();
        assert_eq!(local_path(url.as_str(), None).unwrap(), absolute);
        assert!(local_path("photo.png", None).is_err());
        assert!(local_path("javascript:alert(1)", Some(&document)).is_err());
    }
    #[test]
    fn decodes_and_normalizes_raster_images_but_rejects_other_files() {
        let image = image::RgbaImage::from_pixel(4, 3, image::Rgba([20, 120, 220, 255]));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let result = decode(bytes.get_ref()).unwrap();
        assert_eq!((result.width, result.height), (4, 3));
        assert!(result.data_url.starts_with("data:image/png;base64,"));
        assert!(decode(b"not an image").is_err());
        assert!(decode(b"<svg><script>alert(1)</script></svg>").is_err());
        assert!(decode(&vec![0; MAX_BYTES + 1]).is_err());
    }
    #[test]
    fn jpeg_camera_orientation_is_applied() {
        let photo = image::RgbImage::new(2, 3);
        let mut jpeg = Cursor::new(Vec::new());
        photo.write_to(&mut jpeg, ImageFormat::Jpeg).unwrap();
        let mut exif = b"Exif\0\0II".to_vec();
        exif.extend(42u16.to_le_bytes());
        exif.extend(8u32.to_le_bytes());
        exif.extend(1u16.to_le_bytes());
        exif.extend(0x112u16.to_le_bytes());
        exif.extend(3u16.to_le_bytes());
        exif.extend(1u32.to_le_bytes());
        exif.extend(6u16.to_le_bytes());
        exif.extend(0u16.to_le_bytes());
        exif.extend(0u32.to_le_bytes());
        let mut oriented = jpeg.get_ref()[..2].to_vec();
        oriented.extend([0xff, 0xe1]);
        oriented.extend(((exif.len() + 2) as u16).to_be_bytes());
        oriented.extend(exif);
        oriented.extend(&jpeg.get_ref()[2..]);
        let result = decode(&oriented).unwrap();
        assert_eq!((result.width, result.height), (3, 2));
    }
    #[test]
    fn local_and_embedded_images_load() {
        let dir = tempfile::tempdir().unwrap();
        let photo = image::RgbImage::new(8, 6);
        let path = dir.path().join("photo one.png");
        photo.save(&path).unwrap();
        let result = tauri::async_runtime::block_on(load(
            "photo%20one.png".into(),
            Some(dir.path().join("notes.md")),
        ))
        .unwrap();
        assert_eq!((result.width, result.height), (8, 6));
        let embedded = tauri::async_runtime::block_on(load(result.data_url, None)).unwrap();
        assert_eq!(embedded.width, 8);
    }
    #[test]
    #[ignore = "requires loopback sockets"]
    fn remote_images_follow_redirects_and_report_http_errors() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let photo = image::RgbImage::new(7, 5);
        let mut bytes = Cursor::new(Vec::new());
        photo.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 4096];
                let count = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..count]);
                if request.starts_with("GET /redirect ") {
                    stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: /photo\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                } else if request.starts_with("GET /photo ") {
                    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.get_ref().len()).unwrap();
                    stream.write_all(bytes.get_ref()).unwrap();
                } else {
                    stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                }
            }
        });
        let loaded =
            tauri::async_runtime::block_on(load(format!("http://{address}/redirect"), None))
                .unwrap();
        assert_eq!((loaded.width, loaded.height), (7, 5));
        let missing =
            tauri::async_runtime::block_on(load(format!("http://{address}/missing"), None));
        assert!(missing.is_err());
        server.join().unwrap();
    }
}
