# Workflowy Sync

By Rodolfo Terriquez.

Workflowy Sync is an Obsidian plugin that connects your vault to Workflowy so you can quickly send content, embed live outlines, and sync mapped notes.

## What it does today

- Send the current selection, or the current line when nothing is selected, to Workflowy
- Use a saved default target or choose a target on demand
- Embed a live Workflowy node or subtree inside a note with a `workflowy` code block
- Create sync mappings between one Workflowy item and one Obsidian note
- Sync Workflowy -> Obsidian manually or on a schedule
- Sync Obsidian -> Workflowy manually or on a schedule
- Sync into a managed block under a note heading instead of replacing the whole note

## Use cases

- Capture selected text or the current line into Workflowy without leaving Obsidian
- Show a live Workflowy subtree inside a note
- Keep a Workflowy item and an Obsidian note section aligned with one-way scheduled sync
- Push structured Markdown outlines from Obsidian back into a Workflowy subtree

## Setup

1. Create or copy a Workflowy API key.
2. Open **Settings → Community plugins → Workflowy Sync**.
3. Paste the API key and use **Test connection**.
4. Optionally save a default target by pasting a Workflowy node URL, node ID, or target key such as `inbox`.

## Commands

- **Sync: Send to Workflowy**
- **Sync: Send to Workflowy target...**
- **Sync: Workflowy mapping now**

If text is selected, the send commands use the selection. If nothing is selected, they send the current line.

If backlinking is enabled, sent items include an `obsidian://` link in the Workflowy note.

## Live embeds

Use a code block like this:

````
```workflowy
node: https://workflowy.com/#/your-node-id
```
````

The block renders the target node and its subtree, shows the last refresh time, and includes a manual refresh button.

## Sync mappings

Sync mappings connect one Workflowy item to one Obsidian note.

- `Workflowy -> Obsidian` pulls Workflowy content into a note or into a named heading block.
- `Obsidian -> Workflowy` keeps the mapped Workflowy root item and replaces its child content in place.

### Obsidian -> Workflowy rules

- The mapped Workflowy root item keeps its existing name.
- Only note content is synced. The Obsidian note title is not pushed into Workflowy as the root item name.
- Plain non-empty lines become child bullet items when there is no explicit Markdown list syntax.
- Markdown list items become Workflowy bullets or todos.
- Item notes in Obsidian are supported, but they require extra follow-up API calls and may sync more slowly than plain lists.
- This is still a one-way push per run, not full bidirectional merge or conflict handling.

### Workflowy -> Obsidian rules

- Only the Workflowy root item's content and children are synced. The root title is not inserted as a Markdown heading.
- Child Workflowy items become Markdown bullets or todos.
- Workflowy notes become blockquotes.
- If a mapping targets a note section, the plugin manages only its own sync block under that heading and leaves other content alone.

## Current limitations

- Sync mappings are not full bidirectional merge sync yet.
- Conflicts are not merged automatically.
- Reverse sync works best with headings, bullets, todos, and simple item notes.

## Privacy and network use

- This plugin requires a Workflowy account and API key.
- It sends selected note content, mapped note content, and requested Workflowy item identifiers to Workflowy when you use send, embed refresh, or sync features.
- Reverse sync uses Workflowy document-editing endpoints to update the mapped Workflowy subtree in place.
- The plugin stores its settings and mappings locally in Obsidian.
- The plugin does not include analytics or telemetry.

## Development

```bash
npm install
npm run dev
```

For local Obsidian testing, the plugin folder name should eventually match the manifest ID: `workflowy-sync`.
