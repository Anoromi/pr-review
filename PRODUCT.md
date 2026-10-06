# PR Review

## Register

product

## Users

A developer on Linux reviewing GitHub pull requests in a desktop browser. They want to select code, write feedback, and hand the resulting Markdown to their coding agent without copying comments individually.

## Product Purpose

Open a GitHub PR, navigate its diff, attach local comments to lines, and keep a review.md file updated on disk. React and Vite provide the interface; tRPC handles loading and persistence.

## Brand Personality

Compact, direct, familiar. DiffsHub is the reference for the file navigation and diff layout.

## Anti-references

No marketing dashboard, AI reviewer, decorative statistics, or complex Git client. The user rejected tools that made commenting and collecting Markdown cumbersome.

## Design Principles

- Use shadcn/ui controls and a single compact layout.
- Show positions within each stack, independent of filtering or sorting.
- Prefer horizontal space; keep branch details optional.
- Run Vite development mode with HMR during iteration.
- Give code most of the screen.
- Keep comments next to the code they describe.
- Saving a comment also updates Markdown.
- Preserve the revision that gives each comment meaning.
- Make loading and save failures visible and recoverable.

## Accessibility & Inclusion

Keyboard-accessible controls, visible focus, labelled inputs, and change indicators that do not rely only on color. No additional accommodations requested.
