"""The 29 references in the journal's numbered style (author, initials, title, italic venue, bold volume, year).
Authors beyond five are abbreviated to "First, A. et al." as in the reference document. Keys are those of ../refs.bib."""


def r(t, i=False, b=False):
    d = {'t': t}
    if i:
        d['i'] = True
    if b:
        d['b'] = True
    return d


def _conf(authors, title, venue, tail=''):
    return [r(authors + ' ' + title + '. In '), r(venue, i=True), r(tail + '.')]


def _jour(authors, title, journal, vol, pages, year):
    return [r(authors + ' ' + title + '. '), r(journal, i=True), r(' '), r(vol, b=True), r(f', {pages} ({year}).')]


NIPS = 'Advances in Neural Information Processing Systems'
NIPSDB = 'Advances in Neural Information Processing Systems, Datasets and Benchmarks Track'
ICLR = 'International Conference on Learning Representations'

REFS = {
    'zhao2024nl2formula': _conf('Zhao, W. et al.', 'NL2Formula: generating spreadsheet formulas from natural language queries',
                                'Findings of the Association for Computational Linguistics: EACL 2024', ' (2024)')[:-1] + [r('.')],
    'joshi2024flame': _jour('Joshi, H. et al.', 'FLAME: a small language model for spreadsheet formulas', 'Proc. AAAI Conf. Artif. Intell.', '38', '12995–13003', 2024),
    'li2023sheetcopilot': _conf('Li, H., Su, J., Chen, Y., Li, Q. & Zhang, Z.', 'SheetCopilot: bringing software productivity to the next level through large language models', NIPS, ' (2023)'),
    'ma2024spreadsheetbench': _conf('Ma, Z. et al.', 'SpreadsheetBench: towards challenging real world spreadsheet manipulation', NIPSDB, ' (2024)'),
    'dong2024spreadsheetllm': [r('Dong, H. et al. SpreadsheetLLM: encoding spreadsheets for large language models. arXiv:2407.09025 (2024).')],
    'singha2025forepbench': _conf('Singha, A. et al.', 'Benchmark dataset generation and evaluation for Excel formula repair with LLMs',
                                  'KDD Workshop on Evaluation and Trustworthiness of Agentic and Generative AI Models', ', arXiv:2508.11715 (2025)'),
    'thorne2025flare': _conf('Thorne, S.', 'Large language models for spreadsheets: benchmarking progress and evaluating performance with FLARE',
                             'Proceedings of the EuSpRIG 2025 Conference: Spreadsheet Risk Management', ', arXiv:2506.17330 (2025)'),
    'chen2025sheetmind': [r('Chen, L. et al. SheetMind: actions set accuracy, agents set the failure mode. arXiv:2506.12339 (2025).')],
    'tian2025sheetpedia': _conf('Tian, Z., Han, Z., Wang, H. & Liao, L.', 'Sheetpedia: a 300K-spreadsheet corpus for spreadsheet intelligence and LLM fine-tuning', NIPSDB, ' (2025)'),
    'chen2024selfdebug': _conf('Chen, X., Lin, M., Schärli, N. & Zhou, D.', 'Teaching large language models to self-debug', ICLR, ' (2024)'),
    'huang2024selfcorrect': _conf('Huang, J. et al.', 'Large language models cannot self-correct reasoning yet', ICLR, ' (2024)'),
    'poesia2022synchromesh': _conf('Poesia, G. et al.', 'Synchromesh: reliable code generation from pre-trained language models', ICLR, ' (2022)'),
    'yao2023react': _conf('Yao, S. et al.', 'ReAct: synergizing reasoning and acting in language models', ICLR, ' (2023)'),
    'mohammadi2026atomix': [r('Mohammadi, B., Potamitis, N., Klein, L., Arora, A. & Bindschaedler, L. Atomix: timely, transactional tool use for reliable agentic workflows. arXiv:2602.14849 (2026).')],
    'sun2026agentic': [r('Sun, Z., Wang, X. & Li, G. Agentic transaction: towards ACID-compliant agent systems. arXiv:2608.13900 (2026).')],
    'debenedetti2024agentdojo': _conf('Debenedetti, E. et al.', 'AgentDojo: a dynamic environment to evaluate prompt injection attacks and defenses for LLM agents', NIPSDB, ' (2024)'),
    'ruan2024toolemu': _conf('Ruan, Y. et al.', 'Identifying the risks of LM agents with an LM-emulated sandbox', ICLR, ' (2024)'),
    'spracklen2025package': _conf('Spracklen, J. et al.', 'We have a package for you! A comprehensive analysis of package hallucinations by code generating LLMs', 'USENIX Security Symposium', ' (2025)'),
    'dubey2024llama3': [r('Grattafiori, A. et al. The Llama 3 herd of models. arXiv:2407.21783 (2024).')],
    'hyperformula': [r('Handsontable. HyperFormula: an open-source calculation engine for spreadsheets. Version 3.4.0 (GPL-3.0), https://github.com/handsontable/hyperformula (2026).')],
    'googlefunctions': [r('Google. Google Sheets function list. https://support.google.com/docs/table/25273 (accessed 2 October 2026) (2026).')],
    'owaspssrf': [r('OWASP. Server-Side Request Forgery Prevention Cheat Sheet. OWASP Cheat Sheet Series, https://cheatsheetseries.owasp.org/ (2025).')],
    'rfc6890': [r('Cotton, M., Vegoda, L., Bonica, R. & Haberman, B. Special-purpose IP address registries. IETF RFC 6890 (2013).')],
    'robertson2009bm25': _jour('Robertson, S. & Zaragoza, H.', 'The probabilistic relevance framework: BM25 and beyond', 'Found. Trends Inf. Retr.', '3', '333–389', 2009),
    'wilson1927': _jour('Wilson, E. B.', 'Probable inference, the law of succession, and statistical inference', 'J. Am. Stat. Assoc.', '22', '209–212', 1927),
    'mcnemar1947': _jour('McNemar, Q.', 'Note on the sampling error of the difference between correlated proportions or percentages', 'Psychometrika', '12', '153–157', 1947),
    'ren2026spreadsheetagent': _conf('Ren, H. et al.', 'Towards robust real-world spreadsheet understanding with multi-agent multi-format reasoning',
                                     'Proceedings of the 64th Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers)', ' 1906–1933 (2026)'),
    'zhu2026spreadsheetbench2': [r('Zhu, J. et al. SpreadsheetBench 2: evaluating agents on end-to-end business spreadsheet workflows. arXiv:2606.29955 (2026).')],
    'singh2025validating': _conf('Singh, U. et al.', 'An empirical study of validating synthetic data for formula generation', 'Findings of the Association for Computational Linguistics: NAACL 2025', ' (2025)'),
}

# the first entry was built with a trailing period inside _conf; make it uniform with the others
REFS['zhao2024nl2formula'] = _conf('Zhao, W. et al.', 'NL2Formula: generating spreadsheet formulas from natural language queries',
                                   'Findings of the Association for Computational Linguistics: EACL 2024', ' (2024)')
