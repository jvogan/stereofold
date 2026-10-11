# Stereofold site

This folder contains the static project site: HTML, bundled browser assets,
artwork, fonts, licenses, and the public 1CRN fixture. Edit these committed
files directly; serving them requires no build step. Keep the design and asset
paths intact when changing page copy.

To preview from the repository root, run:

```sh
python3 -m http.server 8000 --directory docs --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/` in a browser. Check the crambin demo, links, and
responsive layout after changes. Update `llms.txt` and `llms-full.txt` with page
copy changes so agents receive the same capabilities and installation routes.

For public release, enable GitHub Pages under **Settings** > **Pages**, choose
**Deploy from a branch**, and select `main` with `/docs`. The intended address
is [jvogan.github.io/stereofold](https://jvogan.github.io/stereofold/). Verify a
successful deployment before sharing the published site.

`.nojekyll` keeps Pages from reprocessing the static output. `index.html` is the
project page, `credits.html` carries the Mol* citation and license notices,
`404.html` handles unknown addresses, and `sitemap.xml` lists the public pages.
