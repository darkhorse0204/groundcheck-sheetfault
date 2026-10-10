# Annotating real-world formulas

Purpose: give the paper an **independent, human ground truth** for formulas that real people wrote, so that the
verifiers' precision, recall and false-positive rate on real data can be reported. The engine-based evidence used
elsewhere in the paper (HyperFormula evaluating the original formula) is *supporting* evidence, not ground truth.

Two people annotate the same items **independently**, then settle disagreements together.

## What you get

`annotator_A.csv` / `annotator_B.csv` (one per annotator, same items, same order). Each row is one formula:

| column | meaning |
|---|---|
| `id` | item number |
| `workbook_file`, `sheet`, `cell` | where the formula lives in the Sheetpedia release |
| `formula` | the formula, exactly as stored |
| `context` | the workbook's sheet names and sizes, the first rows of the target sheet, the neighbourhood of the target cell, and the first rows of any other sheet the formula names |

The files contain **no verifier output**; do not run the verifiers while annotating, and do not look at
`key.json`. The files hold text from CC BY-SA workbooks: do not publish them.

## What to fill in

Your own four columns (`A_…` or `B_…`):

* `…_defect` — **Y**, **N** or **U**.
  * **Y**: the formula, as written in this workbook, is defective. Either it would show an error value (a broken or
    deleted reference, a sheet or name that does not exist, a wrong number of arguments, a circular reference, …), or it
    would show a plausible value but is evidently wrong for the data shown (it sums a text column, looks up a value that
    is not in the column, uses a range that clearly misses the data, compares ranges of different sizes, …).
  * **N**: you can see no defect.
  * **U**: you cannot tell from what is shown. Open the original workbook (`workbook_file`) if that would settle it; if
    it still does not, use U.
* `…_visibility` — for Y only: **loud** (the cell would show an error) or **silent** (a plausible but wrong value).
* `…_category` — for Y only, one of: `broken-reference` (a `#REF!` left in the formula), `missing-sheet`,
  `missing-name` (unknown function or name), `circular`, `range-extent` (range outside or beyond the data),
  `argument-shape` (wrong argument count or range sizes), `text-in-numeric`, `absent-criterion`, `indirect`
  (INDIRECT that cannot resolve), `other`.
* `…_note` — optional free text.

## Rules of thumb

* Judge the formula **in its workbook**, not in the abstract. `=SUM(A:A)` is fine unless it sits in column A.
* Do **not** judge style, efficiency, hard-coded constants, or whether the formula matches an intent you can only guess.
  If correctness depends on intent you cannot see, answer N (or U if you genuinely cannot tell whether it is broken).
* A formula wrapped in `IFERROR` that hides a missing sheet is still defective (Y, silent).
* Functions that exist in Excel but not in Google Sheets (e.g. `SORTBY`) are defects for a Google Sheets user; custom or
  add-in functions that you cannot check are U.
* Do not discuss items with the other annotator until both files are complete.

## After annotating

1. Compare the two files; list the ids on which `…_defect` differs and settle them together. Write the result to
   `adjudicated.csv` with columns `id,defect,visibility,category`.
2. `node annotation/score_annotation.js <dir> --adjudicated adjudicated.csv` reports agreement (raw and Cohen's kappa),
   and weighted precision, recall and false-positive rate of the shipped verifier and GroundCheck with
   workbook-clustered 95% intervals, and writes `results/annotation_summary.json`.
3. `node make_paper_assets.js` then adds the numbers to the paper's Appendix F automatically.

Expect two to three hours per annotator for 400 items.

## Rebuilding the sample

```
node annotation/make_sheet.js <corpus.json> results/e1b_fresh.rows.json --n 400 --seed 3 --out annotation/out
```

`corpus.json` is the output of `realworld/extract.py` for the confirmation set (not redistributed). The sample is
stratified by the verifiers' decisions (GroundCheck rejects / only warns / accepts while the shipped verifier rejects /
both accept) so that rare cases are well covered; scores are weighted back to the population. Formulas that the
dataset's PII pass blanked to `=` are excluded.
