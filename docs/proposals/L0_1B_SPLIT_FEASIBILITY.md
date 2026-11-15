# L0-1b: split See-through layers into limbs (feasibility study)

**Draft. Research result.** This report does not close a decision. It does not approve a part, a pivot, or a package.
The images of this study are derivatives of the L0 test concept. They stay in the project shared folder. They are not in Git.

## tl;dr

The L0-1 See-through run gave 18 semantic layers. Both arms are in `handwear`, both legs in `legwear`, and both shoes in `footwear`.
Without new inference, a geometric split gives independent left and right **shoes** (100 % of the pixels, exact) and independent left and right **whole arms** (99.98 % of the alpha, exact).
The **legs** split only below the skirt hem. The upper thighs (27,077 pixels, 81 % hidden under the skirt) are one painted shape. A split there is a guess, so the tool keeps it as a residual.
No part is ready for Spine. Elbows, wrists and knees are not split, the pivots are hypotheses, and the joints have no extra painted overlap.

## 1. Scope and limits

- Input: the L0-1 output files (`concept-mirrored/<tag>.png`, 1280 x 1280 8-bit RGBA, and `concept-mirrored.psd.json`). The PSD files were not used, because the PNG files hold the same layers.
- Local run only. No GPU, no model, no inference, no network, no change to the input files.
- Tool: `aigg-control split-layers` (`@aigg/control` 0.7.0, prototype). See [the package README](../../packages/control/README.md#layer-split-l0-1b).
- The study answers one question: can the current L0-1 output give independent animatable parts without new generative inference?
- Out of scope: a Spine skeleton, rig contract changes, elbow and knee cuts, pivots for production, near and far side names, and cleanup.

## 2. Method

### 2.1 Mask analysis (task A)

For each of `handwear`, `legwear`, `footwear`, `topwear`, and `bottomwear`:

- The alpha mask (alpha above 0) and its 8-connected components at alpha thresholds 1, 32, 128, and 250.
- A component is major when its area is at least 2 % of the layer area.
- Exact alpha bounds (xyxy, right and bottom edges exclusive) and the difference to the metadata `xyxy`.
- Shared pixels with each other layer, and pixels that the layers above hide in the reference pose (painted but not visible).

### 2.2 Split (task B)

The split uses no cut line. It finds one seed for each expected part in this fixed order:

1. Connected components at alpha 1, then at alpha 32, 64, 128, and 192 (`components`, `alpha_threshold`).
2. Erosion of the alpha 128 core, up to 12 px (`erosion`).
3. For legs only: the scan rows with exactly two runs of pixels (`scan_rows`). In those rows, background separates the two parts.

Each other layer pixel goes to the seed with the shortest path inside the layer.
A pixel stays in the **residual** when the decision is not clear:

| Residual kind | Meaning                                                                               |
| ------------- | ------------------------------------------------------------------------------------- |
| `merged`      | A region that touches two parts (`scan_rows`). The parts are joined or overlap there. |
| `contact`     | Path distance to two seeds differs by 2 px or less.                                   |
| `isolated`    | A fragment that is not connected to a seed and not within 8 px of exactly one part.   |
| `unsplit`     | No seeds were found. All pixels stay together.                                        |

Parts are named by image side (`image_left`, `image_right`). A mapping to the rig sides (`near`, `far`) needs a human decision.
Each part PNG has the full 1280 x 1280 canvas and the source RGBA values without change.

### 2.3 Metadata (task C)

`l0-1b.json` records, for each part and residual: the file SHA-256 and pixel SHA-256, the source layer and its file hashes, the exact alpha bounds on the 1280 x 1280 canvas, the area, the alpha sum, the hidden pixels, and the split method and parameters.
The automatic bounds are measurements. They are not Spine attachment rectangles.

### 2.4 Trial motion (task D)

Each part of a split layer is turned about a **pivot hypothesis H1**: the centroid of the part pixels in its top 20 rows. H1 is not a rig pivot.
The image-left part turns by +angle, the image-right part by -angle (arms 20 degrees, legs 12 degrees, shoes 15 degrees). The residual stays in place.
The diagnostic map shows: holes with nothing behind (red), lower layers that become visible (yellow), new overlaps (blue), and gaps within 40 px of a pivot (magenta).
The rotation uses nearest-neighbor resampling. It is for diagnosis only.

## 3. Results

### 3.1 Automatic checks

| Check | Result | Meaning                                                                                                                  |
| ----- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| S1    | PASS   | Each split layer is an exact partition: 0 lost, 0 duplicated, 0 changed pixels, equal alpha sum.                         |
| S2    | PASS   | The reference pose from the parts and residuals has the same pixel hash as the reference pose from the 18 source layers. |
| S3    | PASS   | All analyzed layers have a PNG file and a metadata entry.                                                                |
| —     | PASS   | The SHA-256 of all 50 input PNG files and the metadata file are the same before and after the run.                       |
| —     | PASS   | Two runs give byte-identical output files (27 files).                                                                    |

Limit of S1: the RGB values of fully transparent source pixels (alpha 0) are not kept. They are not visible. See-through stores color in about 1.59 million alpha-0 pixels of each layer.

### 3.2 Mask analysis

| Layer        | Area (alpha > 0) | Partial alpha | Major components at alpha 1 / 32 | Metadata xyxy        | Alpha xyxy           | Pixels outside xyxy | Hidden by upper layers |
| ------------ | ---------------: | ------------: | -------------------------------- | -------------------- | -------------------- | ------------------: | ---------------------: |
| `handwear`   |           50,431 |        12,688 | 3 / 2                            | 274, 247, 823, 686   | 273, 226, 825, 686   |                 757 |                    303 |
| `legwear`    |           90,043 |         6,633 | 1 / 1                            | 376, 604, 666, 1156  | 373, 602, 666, 1162  |                  42 |                 23,613 |
| `footwear`   |           20,682 |         2,555 | 2 / 2                            | 347, 1118, 689, 1262 | 347, 1117, 689, 1263 |                  18 |                      0 |
| `topwear`    |           48,891 |         5,301 | 1 / 1                            | 438, 237, 650, 543   | 429, 230, 651, 556   |                 430 |                 11,295 |
| `bottomwear` |           51,372 |         3,291 | 1 / 1                            | 381, 503, 715, 727   | 380, 500, 715, 730   |                  55 |                      0 |

Findings:

- `handwear` has a third major component at alpha 1: a faint region of 1,172 pixels near the neck and shoulder (alpha below 32). At alpha 32 and higher, the layer has exactly two arms.
- Each arm is one piece from the sleeve to the fingers: sleeve, skin, wrist band, and glove. The white sleeve caps are in `handwear`, not in `topwear`.
- `legwear` is one region at all thresholds. The thighs join from y 602 to y 728. Below y 728, background separates the legs in every row.
- `footwear` has two clean components.
- `topwear` and `bottomwear` are one region each. They have no limb pixels. `topwear` has 12,778 pixels under the arms (painted torso and sleeve area). `bottomwear` covers 23,315 pixels of `legwear`.
- The metadata `xyxy` is not exact. The largest differences: `handwear` top -21 px (the faint region), `topwear` bottom +13 px and left -9 px, `legwear` bottom +6 px.

### 3.3 Split and measurements (task E)

| Source layer | Parts                        | Split   | Method                 | Assigned pixels | Assigned alpha | Residual                        | Lost / duplicated | Hidden areas need restoration | Confidence |
| ------------ | ---------------------------- | ------- | ---------------------- | --------------: | -------------: | ------------------------------- | ----------------- | ----------------------------- | ---------- |
| `handwear`   | arm image-left, image-right  | yes     | `alpha_threshold` (32) |         97.17 % |        99.98 % | 1,427 isolated (mean alpha 1.1) | 0 / 0             | yes: shoulder joints          | medium     |
| `legwear`    | leg image-left, image-right  | partial | `scan_rows`            |         69.77 % |        69.36 % | 27,077 merged, 139 isolated     | 0 / 0             | yes: upper thighs, hips       | medium     |
| `footwear`   | shoe image-left, image-right | yes     | `components`           |        100.00 % |       100.00 % | none                            | 0 / 0             | small: ankle overlap exists   | high       |

Details:

- Arms: image-left arm 28,317 pixels, xyxy 273, 239, 499, 686. Image-right arm 20,687 pixels, xyxy 577, 313, 825, 651. 313 and 201 faint edge pixels attach to the arms. The isolated residual is almost transparent (alpha sum 1,590 for 1,427 pixels).
- Legs: image-left leg 34,225 pixels, xyxy 375, 728, 547, 1156. Image-right leg 28,602 pixels, xyxy 548, 728, 663, 1143. The merged residual is xyxy 409, 602, 666, 728. 21,859 of its 27,077 pixels (81 %) are hidden under the skirt. See-through painted the hidden thighs as one shape.
- Shoes: image-left shoe 9,685 pixels, xyxy 347, 1118, 431, 1263. Image-right shoe 10,997 pixels, xyxy 554, 1117, 689, 1242. `footwear` overlaps `legwear` by 1,996 pixels at the ankles.

### 3.4 Trial motion (automatic counts)

| Layer      | Turn (degrees) |  Holes | Lower layer visible | New overlap | Gap near a pivot (40 px) |
| ---------- | -------------- | -----: | ------------------: | ----------: | -----------------------: |
| `handwear` | +20 / -20      | 16,932 |              18,936 |      16,862 |                      631 |
| `legwear`  | +12 / -12      | 25,962 |               2,018 |         804 |                      313 |
| `footwear` | +15 / -15      |  4,434 |                 101 |          73 |                      402 |

Most holes are the area that a part leaves when it turns. That is normal for a large turn. The gap near a pivot shows missing joint overlap.

### 3.5 Visual assessment (human review of the diagnostic images)

This section is an opinion from the images. It is not an automatic check.

- Arms: each arm turns as one rigid piece. The torso and sleeve area that `topwear` painted under the arm becomes visible, and it looks acceptable. At the shoulder, the sleeve cap and the skin have no overlap, so a gap opens. The image-right hand holds the sword grip, which is in `objects`. The hand and the sword do not move together.
- Legs: the legs turn below the skirt hem. The thigh band between the hem and y 728 stays in place, so a hard edge opens. The H1 pivot is at the hem, not at the hip. A hip pivot is not possible while the thighs are merged.
- Shoes: the shoes turn cleanly. A small gap opens at the ankle. The 1,996-pixel overlap with the stockings helps.
- Side mapping: the image-left shoe is lower (y 1263 against 1242). That suggests that the image-left leg is the near leg. The arms do not show it clearly. A human must decide.

## 4. Answer

**Can the current L0 output give separate animatable parts without new generative inference?**

Partly.

- **Yes** for left and right shoes, and for left and right whole arms. The split is exact and does not guess.
- **No** for the legs. Below the skirt, the legs split exactly. The upper thighs are one merged painted region, mostly hidden under the skirt. A split there is a guess.

What is missing for animatable parts:

1. **Separate upper thighs.** One of these steps must make two thigh shapes with painted hidden areas: a manual split and repaint in Krita, or a per-leg completion (L0-2 image edit).
2. **Segment cuts at the elbows, wrists, and knees.** The rig needs `upper_arm`, `forearm`, `hand`, `thigh`, `shin`, and `foot` parts. A cut needs joint positions. The concept is not in the C0.5 template pose, so the template joints cannot be used without an alignment step. A cut without a joint reference is a guess.
3. **Joint overlap.** No part has extra painted pixels past the joints (shoulder caps, hips, elbows, knees). Rotation opens gaps.
4. **The hand and the sword.** The grip is in `objects`. The near hand needs a separate grip layer or a hand redraw.
5. **Pivots and attachment rectangles.** The H1 pivots and the alpha bounds are measurements only. The rig contract defines pivots and rectangles. A human must approve them.
6. **Side names.** `image_left` and `image_right` need a human mapping to `near` and `far`.

## 5. Recommendation

1. Keep `split-layers` as an offline step after See-through. It is exact and fast (about 16 s for 1280 x 1280), and it says clearly where it cannot split.
2. Next stage (L0-1c, proposal): one manual cleanup pass in Krita on the merged thigh region and the shoulder overlaps. Log the human time. This shows the cost of the non-generative path.
3. In parallel, prepare the L0-2 per-part completion test for the thighs only. Compare its result and cost with the manual pass.
4. Before elbow and knee cuts: decide how the concept is aligned to the rig template joints (open question). Do not cut limbs at fixed fractions of their length.
5. Do not add a near and far mapping, pivots, or attachment rectangles to the tool until a human decides them.

## 6. Reproduce

```sh
npm ci --ignore-scripts
npm run build --workspace @aigg/control
node packages/control/dist/src/cli.js split-layers \
  --layers <L0-1 output>/concept-mirrored \
  --metadata <L0-1 output>/concept-mirrored.psd.json \
  --out <new output directory>
```

The input is the L0-1 results archive (SHA-256 `c85fcea747b4b40aa73689f25bd292af6ddc489cae40abd0c3c0d37dde218951`), directory `output/`.
The metadata file SHA-256 is `7f33011e4d6b44c16335cab88eec2df254a48e74cb2313f86cbde7a8d6cd2820`.
The output images and `l0-1b.json` are in the project shared folder, `research/l0-1b/`. Do not commit them.
