# License of the files in this folder

`articles.jsonl` holds plain-text extracts of **Wikipedia / Wikinews** pages (Arabic Wikipedia, Arabic Wikinews,
English Wikipedia) collected by `ml/collect_recent.py`. That text is **not** covered by the MIT license of this
repository: it is licensed **CC BY-SA 4.0** (https://creativecommons.org/licenses/by-sa/4.0/), as reported by each
site's API (`siteinfo`) at collection time. Only CC BY / CC BY-SA sources are ever collected.

* **Attribution** - `ATTRIBUTION.md` (same folder) lists every page with its permalink, revision date, license and
  page-history link (= author credit). Keep it with any copy or derivative of these files.
* **Share-alike** - question/answer pairs derived from these texts (`"source": "recent_qa"` in
  `ml/data/rico_sft.jsonl`, see `ml/data/rico_sft.NOTICE.md`) are adaptations; redistribute them under CC BY-SA 4.0.
  Changes made: plain-text extraction, chunking, summarisation into Libyan-dialect Q&A by a language model.
* Not verified news: the extracts reflect the page at its latest revision; they can be wrong, vandalised or outdated.
* The legal status of model weights trained on CC BY-SA text is unsettled; see `docs/ml.md` section "Licenses".
