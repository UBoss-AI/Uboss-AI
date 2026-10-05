# The two typefaces, as files

These are committed rather than fetched so that building this application needs no network.

`next/font/google` downloads the faces from `fonts.gstatic.com` **at build time**. That is fine
until the fetch fails: a CI run failed with thirty-five `Module not found` errors pointing at
`@vercel/turbopack-next/internal/font/google/font`, all from one unreturned request, and
`deploy/Dockerfile.web` runs the same build on the VPS — so the same minute of bad luck could have
failed a production deployment instead.

## What these are

| File                            | Family         | Version | Subset | Weights |
| ------------------------------- | -------------- | ------- | ------ | ------- |
| `inter-variable.woff2`          | Inter          | v20     | latin  | 400–800 |
| `jetbrains-mono-variable.woff2` | JetBrains Mono | v24     | latin  | 400–600 |

Both are variable fonts, so one file carries the whole weight range. They are the exact files the
Google build was already serving — taken from the `latin` `@font-face` block of
`https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800` and the JetBrains Mono
equivalent, which is why the rendering did not change when they moved here.

The latin subset covers ASCII, general punctuation, and the currency and arrow signs the UI uses.
It does not cover accented latin, Greek or Cyrillic, which now come from the fallback face. The
rupee sign is not in it either — and was not in any subset of the Google build, so that one has
always come from the system face.

## Licence

Both families are licensed under the SIL Open Font License 1.1, which permits redistribution as
part of a larger work. Inter is by Rasmus Andersson; JetBrains Mono is by JetBrains s.r.o.

- <https://github.com/rsms/inter/blob/master/LICENSE.txt>
- <https://github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt>

## Replacing them

Fetch the CSS for the family and weights with a browser user-agent, take the `src` URL from the
block whose `unicode-range` begins `U+0000-00FF`, and save it here under the same name. Then run
the type measurement in the deployment notes before and after, because a face whose metrics differ
will move every line of text in the product.
