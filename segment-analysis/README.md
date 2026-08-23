# Segment analysis (exploratory subproject)

Standalone Python/Jupyter exploration to discover ride-segment terrain
categories beyond the main app's flat/climb/descent rule (see
`../CLAUDE.md`). Not part of the Node app — no import relationship either
direction.

The main app classifies every point purely by gradient threshold
(`|grade| <= 1.5%` -> flat, else climb/descent). That's the right call for
a fast, deterministic cardio/strength split, but it can't distinguish
things like a smooth flat road from a stop-start flat one with junctions,
or a sustained climb from a rolling, punchy one. This subproject uses
unsupervised clustering over richer per-segment features (gradient
texture, speed variability, turn rate, stop fraction) to see what other
categories the data actually supports.

## Setup

Use a dedicated virtualenv for this subproject rather than installing into
a shared/base Python environment. On macOS in particular, scikit-learn and
PyTorch each bundle their own OpenMP runtime (Intel `libiomp` vs LLVM
`libomp`); if `numpy` in the environment they share is an MKL build (as
Anaconda's default `numpy` typically is), importing both in one process
can segfault or hang the kernel. A clean venv installing `numpy` from PyPI
(OpenBLAS-linked, no MKL) avoids that entirely — this is why a venv is
used here instead of `pip install`-ing into an existing conda/base env.

```bash
cd segment-analysis
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Register this venv as a Jupyter kernel so notebooks/segment_clustering.ipynb
# (which pins this kernel) actually runs inside it.
python3 -m ipykernel install --user --name segment-analysis-venv --display-name "Python (segment-analysis)"

jupyter lab notebooks/segment_clustering.ipynb
```

If you ever see a `Found Intel OpenMP ('libiomp') and LLVM OpenMP ('libomp')`
warning or a crashed/dead kernel, it means something imported outside this
venv (e.g. the kernel picked up the wrong Python). Confirm Jupyter is
actually using the "Python (segment-analysis)" kernel, not a base/conda one.

## Layout

- `gpx_features.py` — GPX parsing (stdlib `xml.etree`, no `gpxpy`
  dependency) and feature engineering. Distance/elevation-smoothing/
  gradient math mirrors `../src/analysis.js` so segment terrain figures
  stay comparable to the app's own numbers.
- `notebooks/segment_clustering.ipynb` — loads every GPX file in
  `../GPXExamples`, engineers per-60s-window features, clusters them with
  scikit-learn (KMeans, silhouette-picked k) and cross-checks against a
  small PyTorch autoencoder embedding, then visualises and hand-labels
  the resulting categories.
- `output/` — CSVs written by the notebook (git-ignored).
