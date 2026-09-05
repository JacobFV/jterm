# Third-party material in this repository

Beyond the dependencies in `package.json` and `src-tauri/Cargo.toml`, a small
amount of third-party material is copied into the source tree. It is listed here
so that a copy is never mistaken for something this project wrote.

## Simple Icons — `src/lib/brandIcons.tsx`

Eleven SVG paths (Claude, OpenAI, Google Gemini, Ollama, Docker, Kubernetes,
PostgreSQL, Python, Node.js, Git, Terraform) are copied from
[Simple Icons](https://simpleicons.org), whose icon files are released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Two of them
(OpenAI, Ollama) were taken through the Iconify mirror of that set, which is the
same artwork under the same licence.

They are copied rather than depended on because jterm needs eleven glyphs out of
three thousand, and because nothing in this app should fetch a picture from the
network at runtime in order to draw its own interface.

The marks remain the property of their respective owners and are used here to
identify the program a pane is running — the way a file manager uses a file-type
icon. They are not an endorsement, and no affiliation is implied.
