# L0-1f: deterministic joint underlay feasibility

**Draft. Research step.** Status: complete. Result: **PARTIAL**. Both methods close most of the joint gaps inside the C0.5 overlap circle and keep all invariants. Gaps remain outside the circle, and the art quality needs a human review (section 7).
This report does not approve a joint, a pivot, a part, a method, or a package. The parts are not Spine attachments and are not ready for Spine. The study does not change the C0.5 template, the rig contract, the manual marks, the source art, or the L0-1e baseline.

## tl;dr

In L0-1e, the near arm of the test concept was cut into three parts. When the elbow or the wrist turns, a small gap opens, because the art has no pixels under the joint. In L0-1f, we filled that hidden area with two simple, repeatable raster methods, without a model and without manual paint: method A copies the nearest edge pixel, and method B continues the colors along the arm.

Both methods reduce the gap pixels of all tests from 831 to about 190–200. The holes inside the C0.5 overlap circle are closed. The remaining gaps are on the wide side of each joint, outside the circle that the contract permits for the underlay. A and B are almost equal by the metrics and by eye. A small number of fewer gap pixels does not prove good art: an artist must still look at each joint.

## 1. Scope and rules

- Target: the image-left (near) arm, the same parts as L0-1e. Joints: elbow (parent `upper_arm`, child `forearm`) and wrist (parent `forearm`, child `hand`). Each joint is filled separately.
- Local Node.js only. No GPU, no Runpod, no model, no network, no random values.
- The L0-1e cut, renderer, angles, and metrics are used without change. The code change in `limbstudy.ts` only splits the command into a preparation part and an evaluation part. A `limb-study` run after the change gives byte-identical images and metrics (only the tool version in `metrics.json` is different).
- New pixels are permitted only in the underlay region of a joint (section 2). Each new pixel has the provenance `generated_by_deterministic_extension`.
- Out of scope: other limbs, the far arm, Spine export, L0-2.

## 2. Underlay region

For each joint, a pixel is in the region when all of these conditions are true:

1. It is on the child side of the L0-1e cut line.
2. Its distance to the joint mark is at most the C0.5 overlap radius: 24 template px divided by the similarity scale 1.081 = 22.20 image px (not rounded).
3. It is inside the source cross-section of the arm along the cut line (the L0-1e extents).
4. The parent part has no pixel there.

| Joint | Parent      | Region pixels | Axis (degrees) |
| ----- | ----------- | ------------- | -------------- |
| Elbow | `upper_arm` | 732           | 113.1          |
| Wrist | `forearm`   | 769           | 112.4          |

The underlay belongs to the parent part, so it is drawn under the child (C0.5 draw order 22, 23, 25). No child pixel is copied into the parent.

## 3. Methods

**A. Nearest edge (`nearest_edge`).** Each region pixel copies the RGBA of the nearest parent pixel within 3 px before the cut line. Ties go to the lower pixel index. Each new pixel is an exact copy of one source pixel, so no new color is made. A region pixel without a source within the overlap radius is unresolved.

**B. Directional (`directional`).** Each region pixel goes back along the limb axis to a sample 1 px inside the parent, and takes a second sample 6 px farther back.

- When both samples are fully opaque and their RGB step is at most 64, the color continues the gradient, limited to the step between the two samples (`directional_gradient`).
- Otherwise (an outline, a band edge, or a partly transparent pixel) the pixel copies the first sample (`directional_copy`).
- When the first sample has no parent pixel, the pixel is unresolved if the child has a pixel there, and gets no pixel if the child has none (outside the contour).

**Alpha.** Colors are computed only between fully opaque samples. Partly transparent pixels are copied with their RGBA. Thus no color is mixed with transparent black, and no dark or light halo is made. The compositor and the metrics are the L0-1e ones (straight alpha).

**Unresolved.** No method fills an unresolved pixel with an arbitrary color. It stays transparent and is listed in `provenance.json`.

## 4. Fill results

| Method | Joint | New pixels | Gradient | Copy | Unresolved | Outside contour |
| ------ | ----- | ---------- | -------- | ---- | ---------- | --------------- |
| A      | Elbow | 731        | 0        | 731  | 1          | 0               |
| A      | Wrist | 769        | 0        | 769  | 0          | 0               |
| B      | Elbow | 722        | 601      | 121  | 8          | 2               |
| B      | Wrist | 769        | 673      | 96   | 0          | 0               |

Total new pixels: A 1,500, B 1,491. The unresolved pixels are at the corner of the elbow cut, where the child is wider than the parent.

Invariants (both methods): source pixels changed 0; new pixels outside the regions 0; changed frame pixels outside the moved new pixels 0 in all tests. The status in `metrics.json` is `invariants: PASS`.

## 5. Rotation tests

The tests, angles, renderer, and metrics are the L0-1e ones. Positive is clockwise on the screen. The baseline numbers are the same as in the L0-1e report.

### 5.1 Totals over all tests

| Variant  | Gap pixels | Visible seam pixels | Problem pixels |
| -------- | ---------- | ------------------- | -------------- |
| Baseline | 831        | 329                 | 1,377          |
| A        | 190        | 168                 | 630            |
| B        | 198        | 160                 | 631            |

### 5.2 Worst values per joint

| Joint | Variant  | Worst gap | Gap union | Worst protrusion | Worst unwanted overlap | Worst seam |
| ----- | -------- | --------- | --------- | ---------------- | ---------------------- | ---------- |
| Elbow | Baseline | 166       | 247       | 26               | 20                     | 31         |
| Elbow | A        | 41        | 41        | 26               | 20                     | 13         |
| Elbow | B        | 41        | 44        | 26               | 20                     | 13         |
| Wrist | Baseline | 123       | 180       | 20               | 40                     | 32         |
| Wrist | A        | 61        | 61        | 20               | 40                     | 16         |
| Wrist | B        | 61        | 61        | 20               | 40                     | 16         |

### 5.3 Per test (gap / visible seam; baseline → A / B)

| Test                 | Elbow gap     | Elbow seam   | Wrist gap     | Wrist seam   |
| -------------------- | ------------- | ------------ | ------------- | ------------ |
| elbow −15            | 38 → 0 / 3    | 16 → 5 / 3   | –             | –            |
| elbow +15            | 83 → 21 / 21  | 26 → 7 / 5   | –             | –            |
| elbow −30            | 81 → 0 / 3    | 24 → 12 / 13 | –             | –            |
| elbow +30            | 166 → 41 / 41 | 31 → 13 / 11 | –             | –            |
| wrist −15            | –             | –            | 57 → 0 / 0    | 32 → 16 / 16 |
| wrist +15            | –             | –            | 123 → 61 / 61 | 22 → 13 / 14 |
| elbow +10, wrist +10 | 54 → 14 / 14  | 23 → 5 / 5   | 79 → 39 / 39  | 22 → 18 / 18 |
| elbow −10, wrist −10 | 24 → 0 / 2    | 13 → 5 / 4   | 34 → 0 / 0    | 32 → 19 / 18 |
| elbow +10, wrist −10 | 54 → 14 / 14  | 23 → 5 / 5   | 38 → 0 / 0    | 32 → 17 / 15 |

Frame pixels that the new pixels change: 80–160 per turned test.

### 5.4 Why gaps remain

The remaining gaps are on the wide (outer) side of each cut. The cross-section of the arm along the cut is about 25.0 px and 17.0 px on the two sides at the elbow, and 30.5 px and 21.0 px at the wrist. The C0.5 overlap radius is 22.2 image px. Thus the outer part of the wide side is outside the circle, and the region (section 2) does not permit a pixel there. This is a property of the joint mark positions and the overlap rule, not a failure of the methods. We did not change the radius or the metrics to close these gaps.

### 5.5 Other changes

- Protrusion: unchanged.
- Unwanted overlap at the wrist: 0 → 5–9 px in the elbow-only tests, and 24–26 → 34–35 px in two combined tests. The new pixels are inside the circle in the source pose. The probable cause is the nearest-neighbor resampling, which moves pixels near the circle edge by up to about 0.7 px to the outside. This cause is not verified.
- Visible seam: about half of the baseline. The remaining seam pixels are mostly on the outline and the cuff, where the color changes sharply across the cut line in the source art.

## 6. Source pose

| Variant  | Different frame pixels | Largest channel difference |
| -------- | ---------------------- | -------------------------- |
| Baseline | 0                      | 0                          |
| A        | 32                     | 15                         |
| B        | 30                     | 106                        |

The source pose does not stay bit-exact, because the underlay shows through partly transparent edge pixels of the child (the anti-aliased outline). By eye, the three source poses are the same (`6-source-pose.png`).
The B value 106 is one pixel at the outer outline of the wrist: B copied an outline pixel with alpha 194 along the axis, under a child edge pixel with alpha 116, so that frame pixel became darker. All other differences are 19 or less. A copies a nearer pixel with a lower alpha at this position.

## 7. Visual assessment (human judgment, not a measurement)

- Elbow: A and B both close the wedge and continue the skin tone well. A small dark notch stays at the corner of the outline cut. A and B look almost the same.
- Wrist: the holes at −15 are closed. At +15 a small notch stays on the outer edge, outside the overlap circle. The glove texture continues plausibly at this scale.
- No color halos are visible on the magenta background.
- A makes hard stripes of constant color along the edge direction. B makes a soft continuation of the shading. At the normal view size, the difference is small.

## 8. Synthetic tests

`packages/control/test/underlay.test.ts` uses synthetic limbs only:

- Uniform skin: both methods fill the whole region with the exact skin color.
- Gradient: A keeps the last row; B continues the gradient and does not go past the step between its samples.
- Sharp contour: the outline continues at the sides and does not mix with the skin.
- Partly transparent edge: B copies the RGBA and does not make a gradient with it.
- Decorative band: a band edge at the cut gives the band color as a copy (no mix of band and skin).
- Unresolved: no color is made when no parent color is available.
- Each case checks that source pixels do not change, that new pixels are only in the region, and that each new pixel has a provenance record.
- The command on a synthetic arm: invariants PASS, baseline metrics equal to `limb-study`, smaller gap at elbow +30, the same files on a second run.

## 9. Answers

1. **Were the holes closed?** Inside the C0.5 overlap circle, yes. The gap pixels of all tests go from 831 to 190 (A) and 198 (B). Gaps of up to 41 px (elbow) and 61 px (wrist) remain outside the circle, on the wide side of the cut.
2. **Better by the metrics?** Almost equal. A has fewer gap pixels (190 against 198). B has fewer seam pixels (160 against 168). Problem pixels: 630 against 631.
3. **Better visually?** Almost equal at the normal size. B gives a softer continuation of the shading. A is simpler and makes no new color. There is no clear winner.
4. **Seams, distortion, wrong colors?** Small notches at the outline cut corners and outside the circle. Seam pixels are about half of the baseline. No halos. One darker outline pixel in the B source pose.
5. **Is the source pose kept?** By eye, yes. Not bit-exact: 32 (A) and 30 (B) pixels change where the child edge is partly transparent.
6. **How many new pixels?** A 1,500 (elbow 731, wrist 769). B 1,491 (elbow 722, wrist 769).
7. **Which areas are unresolved?** A: 1 pixel at the elbow. B: 8 pixels at the elbow plus 2 outside the contour. All at the corner of the elbow cut, where the child is wider than the parent. The outer side of each joint outside the circle is not filled by rule.
8. **Is an artist necessary?** Yes, for a review and for small corrections at the outline cut corners and at the outer side of each joint. The deterministic fill can be a first draft for the artist.
9. **Basis for other joints?** A partial basis: the methods work for simple limb shading and bands. Each joint needs its own check of the cross-section against the overlap radius, of the outline corners, and of the art. This study does not show this for other joints.

## 10. Recommendation (not started)

These are proposals for an owner decision. No item is accepted.

- Keep the underlay as a draft input for a human review, not as an automatic production step.
- Before a production decision, compare the cross-section extents with the overlap radius at each joint. Where the cross-section is wider, decide on a larger region or an artist fix. This decision affects the rig contract and is for the owner.
- Make an independent architecture review of L0-1f before L0-2 or other limbs.

## 11. Limits

- One concept, one arm, two joints. The concept is a technical benchmark only.
- The metrics count pixels. They do not measure art quality. A wrong texture can close a gap and look worse.
- The tests use nearest-neighbor resampling. Spine uses linear filtering and mesh deformation. The result is not verified in a Spine runtime.
- The joint marks are human estimates from L0-1d.

## 12. Verification

- `npm run check` passed: format, lint, configuration, workflows, type check, build, and tests.
- Two runs of `underlay-study` on the real inputs gave identical output trees (`diff -r`).
- The input SHA-256 values before and after the runs are the same (`inputs-sha256-before.txt`, `inputs-sha256-after.txt`).
- `SHA256SUMS` lists the tool output bytes. The project file storage re-encodes PNG files, so their bytes change there. `PIXEL-SHA256SUMS` lists the decoded pixel hashes, and the stored files give the same pixel hashes.
- The outputs are derivatives of the licensed test concept. They are stored only outside the repository.
