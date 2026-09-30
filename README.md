# Delta Fonts

Public catalog for **Delta Font Manager** (`21press/delta`).

Sites fetch `index.json` (via jsDelivr), then a family file for weights. **Install** downloads woff2 from `fonts.gstatic.com` into `uploads/21press-delta/fonts/` — never hotlinked from this repo at runtime. Font files are not stored here.

## Layout

```
index.json                 # catalog root (consumed by Delta)
families/{slug}.json       # fontFace (latin, every Delta) + variable/axes/subsets/files (Delta 0.2.3+)
scripts/
  sync.mjs                 # Google Fonts API → index + families
  validate.mjs
  build-index.mjs
  purge-jsdelivr.mjs
```

Delta default URL:

`https://cdn.jsdelivr.net/gh/21press/delta-fonts@main/index.json`

## Family record

- `fontFace` — one latin face per weight/style. Unchanged; read by every Delta version.
- `variable`, `axes` (`[{tag,min,max,default}]`), `subsets` (Google subsets without `menu`) — additive.
- `files.weight` — one face per `@font-face` block Google prints for the wght axis (or the discrete weights of a static family): `{ style, weight, stretch?, subset, unicodeRange, src, slice? }`. CJK families are split into numbered slices (`slice`) under their script subset.
- `files.all` — the same for every axis, only for families with axes beyond `wght`.

Local test of a few families (keeps the rest of `families/`): `SYNC_ONLY="Inter,Roboto Flex" npm run sync`.

## Maintainer workflow

```bash
# Needs GOOGLE_FONTS_API_KEY (or falls back to fonts.google.com metadata)
export GOOGLE_FONTS_API_KEY=…
npm run sync
npm run validate
```

1. `npm run sync` regenerates `families/*.json` + `index.json`.
2. `npm run validate`
3. Merge to `main` (catalog is `@main` via jsDelivr).
4. CI purges jsDelivr for `index.json` and every changed family file on `main` (the sync job purges its own commit; `purge-cdn.yml` covers manual pushes).
5. Delta sites: **Fonts → Catalog → Refresh** (WordPress transient only — CDN already purged).

CI cron runs sync twice a week. Manual: Actions → Sync Google Fonts catalog → Run workflow.

Workflow files live in `.github/workflows/` (`sync.yml`, `validate.yml`, `purge-cdn.yml`). Pushing them needs a token with the **`workflow`** scope (`repo` alone is refused). Optional repo secret: `GOOGLE_FONTS_API_KEY` (sync falls back to fonts.google.com metadata when unset).

| Script | What |
|--------|------|
| `npm run sync` | Fetch Google Fonts, write families + index |
| `npm run validate` | Schema check |
| `npm run build:index` | Rebuild `index.json` from `families/*.json` |
| `npm run check` | CI gate (validate + index in sync) |
| `npm run purge:cdn` | Purge jsDelivr cache for `@main/index.json`; add `-- --changed A..B` for changed family files, `-- --all` for every family |

## License

MIT for this repository’s scripts and catalog JSON. Google Fonts binaries stay under each family’s license (usually OFL-1.1) and are not vendored.
