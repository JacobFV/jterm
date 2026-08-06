//! Reading and writing the files an editor pane has open.
//!
//! Images, video and meshes never come through here — those are handed to the
//! webview as `asset:` URLs so the platform can stream them, rather than
//! marshalling a hundred megabytes through IPC to draw a picture.
//!
//! Text does come through here, because text has to go back: a save must not
//! be able to leave a half-written file behind, and that needs the same
//! write-then-rename dance the session snapshot uses.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Refuse to open anything so large it would take the window down.
///
/// A text editor holding a gigabyte in a `<textarea>`-shaped thing is not a
/// feature. The limit is generous for source code and firm about log files.
const MAX_TEXT_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Serialize)]
pub struct TextFile {
    pub path: String,
    pub contents: String,
    /// True when the bytes were not valid UTF-8 and had to be replaced. The
    /// frontend refuses to save such a file, since writing it back would
    /// corrupt whatever the invalid bytes were.
    pub lossy: bool,
}

#[tauri::command]
pub fn file_read_text(path: String) -> Result<TextFile, String> {
    let path = PathBuf::from(&path);
    let meta = fs::metadata(&path).map_err(|err| format!("cannot open {}: {err}", show(&path)))?;
    if meta.is_dir() {
        return Err(format!("{} is a directory", show(&path)));
    }
    if meta.len() > MAX_TEXT_BYTES {
        return Err(format!(
            "{} is {:.0} MB — too large to open as text",
            show(&path),
            meta.len() as f64 / (1024.0 * 1024.0)
        ));
    }

    let bytes = fs::read(&path).map_err(|err| format!("cannot read {}: {err}", show(&path)))?;
    let (contents, lossy) = match String::from_utf8(bytes) {
        Ok(text) => (text, false),
        Err(err) => (String::from_utf8_lossy(err.as_bytes()).into_owned(), true),
    };

    Ok(TextFile {
        path: path.to_string_lossy().into_owned(),
        contents,
        lossy,
    })
}

/// Save, without a window in which the file is neither the old nor the new one.
///
/// The temporary is created beside the target rather than in the system temp
/// directory, so the rename stays within one filesystem — across a mount point
/// it would not be atomic, and on some platforms would fail outright.
#[tauri::command]
pub fn file_write_text(path: String, contents: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "untitled".into());
    let temp = parent.join(format!(".{name}.jterm-tmp"));

    let write = || -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        Ok(())
    };
    write().map_err(|err| format!("cannot write {}: {err}", show(&path)))?;

    // A file that already existed keeps its permissions; a rename would
    // otherwise silently replace them with the temporary's.
    if let Ok(existing) = fs::metadata(&path) {
        let _ = fs::set_permissions(&temp, existing.permissions());
    }

    fs::rename(&temp, &path).map_err(|err| {
        let _ = fs::remove_file(&temp);
        format!("cannot save {}: {err}", show(&path))
    })
}

fn show(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("jterm-files-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        dir.join(name)
    }

    #[test]
    fn round_trips_text() {
        let path = scratch("note.txt");
        file_write_text(path.to_string_lossy().into_owned(), "hello\n".into()).unwrap();
        let read = file_read_text(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(read.contents, "hello\n");
        assert!(!read.lossy);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn overwrites_without_leaving_a_temporary() {
        let path = scratch("twice.txt");
        let name = path.to_string_lossy().into_owned();
        file_write_text(name.clone(), "first".into()).unwrap();
        file_write_text(name.clone(), "second".into()).unwrap();
        assert_eq!(file_read_text(name).unwrap().contents, "second");
        assert!(!path.with_file_name(".twice.txt.jterm-tmp").exists());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn flags_a_file_that_is_not_utf8() {
        let path = scratch("binary.bin");
        fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        let read = file_read_text(path.to_string_lossy().into_owned()).unwrap();
        assert!(read.lossy, "invalid bytes must be reported, not saved back");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn refuses_a_directory() {
        assert!(file_read_text(std::env::temp_dir().to_string_lossy().into_owned()).is_err());
    }
}
