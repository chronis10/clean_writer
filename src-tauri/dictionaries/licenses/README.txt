Clean Writer bundled spelling dictionaries

English: en_US.aff and en_US.dic from Ubuntu hunspell-en-us (SCOWL).
The original copyright and redistribution terms are in en_US.txt.

Greek: el_GR.aff and el_GR.dic from Ubuntu hunspell-el 1:7.2.0-2
(LibreOffice dictionaries). Copyright Evripidis Papakostas (2002) and
Steve Stavropoulos (2006). The dictionary is offered under MPL-1.1,
GPL-2.0, or LGPL-2.1; Clean Writer distributes it under MPL-1.1.
The original notices and license texts are preserved in el_GR.txt.
Modification: converted ISO-8859-7 data to UTF-8 and updated the SET
encoding directive. No word-list changes were made.

Corresponding dictionary source files, including these modifications,
are included in the Clean Writer source distribution:
https://github.com/chronis10/clean_writer/tree/rust/src-tauri/dictionaries
The dictionary data is separate from Clean Writer's MIT-licensed code.

Both dictionaries are embedded in the executable at build time. No
system dictionary, language pack, or network download is needed at runtime.

Optional dictionary installer

The Settings language catalog is maintained in ../catalog.json and pins a
revision of https://github.com/LibreOffice/dictionaries. Optional languages
are downloaded only on the user's Install action. Both Hunspell files and all
listed license/readme notices are downloaded together. Installed files live
in the user's app data dictionaries/<locale>/ folder, with license notices in
licenses/ and provenance in source.json. The declared encoding is converted
to UTF-8 and SET updated, as for the bundled Greek pair; word lists are unchanged.
Optional dictionaries are not part of Clean Writer's MIT-licensed code.
