# Glossary

**Draft.** Use these terms in code, data, and documentation. Use one term for each concept.

## Rig terms

| Term                 | Meaning                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Bone                 | An element of the skeleton hierarchy. It has a position, a rotation, and a scale. Animations move bones.             |
| Slot                 | A place for one image on a bone. The slot sets the draw order. A slot can be empty.                                  |
| Attachment           | The image or mesh in a slot. A skin is a set of attachments.                                                         |
| Skin                 | The set of attachments for one character. All skins use the same bones and slots.                                    |
| Skeleton             | The bones, slots, and draw order of the master rig. All characters share one skeleton.                               |
| Master rig           | The single Spine project that contains the skeleton and all animations.                                              |
| Animation set        | The shared list of animations in the master rig, for example `idle`, `run`, and `hit`.                               |
| Pivot                | The rotation point of a bone, in contract space.                                                                     |
| Joint overlap        | The area around the pivot of a child bone that the parent attachment must cover, so that no gap shows when it bends. |
| Attachment rectangle | The fixed rectangle in contract space that holds the attachment of one slot. It is the same for all characters.      |
| Point                | A bone without an image that marks a position, for example `grip` or `muzzle`.                                       |
| Near / far           | The side of the body that is nearer to or farther from the viewer in the reference view.                             |

## Factory terms

| Term              | Meaning                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Rig contract      | The versioned rules that every character package must obey. See [the rig contract](RIG_CONTRACT.md).                              |
| Contract space    | Pixel coordinates on the contract canvas. The Y axis points down. The origin is the top-left corner.                              |
| Rig space         | Spine coordinates. The Y axis points up. The origin is the `root` bone.                                                           |
| Mannequin         | The reference body in the reference pose. Control images for generation come from it.                                             |
| Base body         | The shared skin parts (arms, legs, neck, torso). They are drawn once and are part of the contract.                                |
| Character package | All data of one character: parts, sidecar, sources, derived files, and QA output. See [the package format](CHARACTER_PACKAGE.md). |
| Part              | One PNG file in a character package. It becomes one attachment.                                                                   |
| Sidecar           | The `character.json` file. It describes the parts and the provenance of one character.                                            |
| Layer             | One image layer in a PSD, ORA, or decomposition output. A layer is not a part until the assembly stage maps it to a slot.         |
| Concept           | A free-pose image of a character design. A human selects one concept.                                                             |
| Production art    | An image of the selected design in the reference pose. Decomposition uses it.                                                     |
| Decomposition     | The stage that splits production art into semantic layers.                                                                        |
| Assembly          | The stage that maps layers and base body parts to contract slots and writes parts.                                                |
| Provenance        | The record of models, file hashes, seeds, workflows, and tool versions that made a result.                                        |
| Derived file      | A file that a script makes from canonical data, for example PSD, atlas, or preview. It is never edited as the source of truth.    |
