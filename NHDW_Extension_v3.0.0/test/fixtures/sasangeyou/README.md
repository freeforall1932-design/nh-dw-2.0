# Sasangeyou sanitized semantic observation

`semantic-observation.json` is a sanitized summary of the public title page and
all three reader pages retrieved through the page tool. The tool returned
**Markdown converted from the pages, not raw HTML or a browser DOM**. The
fixture retains observed chapter order, aggregate counts, reader modes, server
labels, and the ordered references from each page (33, 72, and 61). Host
classes and suffix shapes are recorded,
but do not prove the content or validity of the images. The title, chapter
labels beyond their numbers, and every URL path are fictional; `example.test`
URLs cannot refer to a real title or file. The observation does not establish
which server produced the converted pages' reader references. The second and
third readers also exposed navigation targets outside the title's chapter list;
the fixture records only that mismatch, not those unrelated destinations.

The series page displayed a Premium label, but the anonymous retrieval returned
metadata and image references. This does not establish an entitlement to save,
prove the reader's images are accessible, or justify bypassing access controls.
No image bytes, credentials, private URLs or signed URLs were fetched or saved.
The batch reference shown under related series must not be treated as a batch
for the current title. The absence of a current-title batch in the converted
output does not establish that one does not exist.

The offline `test/chapter-plan.test.js` suite uses this fixture to exercise the
unwired `src/utils/chapterPlan.ts` chapter-selection and reader-order planner.
It cannot prove real DOM selectors, downloaded image validity, browser
permissions, server equivalence or live-site support. A sanitized raw DOM and
an authorized non-explicit real-browser test remain separate verification steps.
