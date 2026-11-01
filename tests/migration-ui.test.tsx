import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import type { MigrationStateDto } from "../src/core/vault/migration.ts";
import { JoinView } from "../components/vault/Join.tsx";
import { MigrationCheckView, MovedAsideView } from "../components/vault/Migration.tsx";

const noop = () => undefined;
const report = { layout: "older", graphFormat: 1, counts: { sessions: 3, jobs: 1, ledgerFiles: 4, prompts: 1, conflicts: 2 }, steps: [{ id: "backup", title: "Back up", files: 9, examples: [] }, { id: "graph-format", title: "Stamp the knowledge map as format 2", files: 1, examples: [] }], conflicts: [], unreadable: ["chats/torn.json"], blocked: null, syncthing: [], needed: true };
const state = (over: Partial<MigrationStateDto> = {}): MigrationStateDto => ({ report: { ...report, steps: [...report.steps] } as MigrationStateDto["report"], syncthing: { needed: false, markers: [], steps: [] }, lastUpgrade: null, movedAside: [], ...over });

test("join: the merge button and its explanation show only when the screen can merge", () => {
	const plain = renderToString(<JoinView email="a@b.co" localFiles={3} busy={false} onUse={noop} onCancel={noop} />);
	assert.doesNotMatch(plain, /Merge with the vault/);
	const html = renderToString(<JoinView email="a@b.co" localFiles={3} busy={false} onUse={noop} onMerge={noop} onCancel={noop} />);
	assert.match(html, />Merge with the vault</);
	assert.match(html, />Use the vault</);
	assert.match(html, /conflict copy/);
	assert.equal((renderToString(<JoinView email="a@b.co" localFiles={3} busy={true} onUse={noop} onMerge={noop} onCancel={noop} />).match(/disabled=""/g) ?? []).length, 3);
	assert.doesNotMatch(renderToString(<JoinView email="a@b.co" localFiles={0} busy={false} onUse={noop} onMerge={noop} onCancel={noop} />), /Merge with the vault/, "nothing to merge without local data");
});

test("migration check: says what the first sign-in changes and that a backup comes first", () => {
	const html = renderToString(<MigrationCheckView state={state()} busy={false} moved={false} onSetAside={noop} onRecheck={noop} />);
	assert.match(html, /3 sessions, 1 job, 2 conflict copies/);
	assert.match(html, /copies this folder to a backup/);
	assert.match(html, /Stamp the knowledge map as format 2[^<]*(<!-- -->)? \(<!-- -->1/);
	assert.doesNotMatch(html, />Back up</);
	assert.match(html, /2 Syncthing conflict copies found/);
	assert.match(html, /1 file could not be read/);
	assert.doesNotMatch(html, /syncthing-guide/);
});

test("migration check: data from a newer build is refused plainly; nothing to show for an empty folder", () => {
	const blocked = renderToString(<MigrationCheckView state={state({ report: { ...report, steps: [], blocked: { reason: "data_newer", paths: ["graph/format.json"] } } as never })} busy={false} moved={false} onSetAside={noop} onRecheck={noop} />);
	assert.match(blocked, /saved by a newer LearnHarness/);
	assert.match(blocked, /data-tone="error"/);
	assert.equal(renderToString(<MigrationCheckView state={state({ report: { ...report, layout: "empty", counts: { sessions: 0, jobs: 0, ledgerFiles: 0, prompts: 0, conflicts: 0 }, steps: [], needed: false } as never })} busy={false} moved={false} onSetAside={noop} onRecheck={noop} />), "");
});

test("migration check: the Syncthing guide lists the steps and offers the set-aside only for markers in the data folder", () => {
	const steps = ["Close it.", "Remove the folder in Syncthing.", "Come back here."];
	const mine = renderToString(<MigrationCheckView state={state({ syncthing: { needed: true, markers: [{ name: ".stfolder", folder: "/d", canSetAside: true }, { name: ".stversions", folder: "/d", canSetAside: true }], steps } })} busy={false} moved={false} onSetAside={noop} onRecheck={noop} />);
	assert.match(mine, /This folder is shared with Syncthing/);
	for (const s of steps) assert.match(mine, new RegExp(s.replace(".", "\\.")));
	assert.match(mine, />I removed it everywhere</);
	assert.match(mine, /Found: \.stfolder, \.stversions\./);
	const above = renderToString(<MigrationCheckView state={state({ syncthing: { needed: true, markers: [{ name: ".stfolder", folder: "/", canSetAside: false }], steps } })} busy={false} moved={false} onSetAside={noop} onRecheck={noop} />);
	assert.doesNotMatch(above, /I removed it everywhere/);
	assert.match(above, /marks a folder above this one/);
	assert.match(above, />Check again</);
	assert.match(renderToString(<MigrationCheckView state={state()} busy={false} moved={true} onSetAside={noop} onRecheck={noop} />), /marker files are moved aside and kept/);
});

test("moved aside: each folder offers a merge, shows its result afterwards, and nothing renders without folders", () => {
	assert.equal(renderToString(<MovedAsideView folders={[]} busy={null} done={{}} onMerge={noop} />), "");
	const folders = [{ name: "pre-vault-20261101", sessions: 2, files: 7, merged: false }];
	const html = renderToString(<MovedAsideView folders={folders} busy={null} done={{}} onMerge={noop} />);
	assert.match(html, /pre-vault-20261101: 2 sessions, 7 files/);
	assert.match(html, />Merge into the vault</);
	const done = renderToString(<MovedAsideView folders={folders} busy={null} done={{ "pre-vault-20261101": { sessions: { added: 1, continued: 1, identical: 0, keptVault: 0, conflictCopies: 1 }, graphLines: { added: 5, linked: 0 } } as never }} onMerge={noop} />);
	assert.match(done, /Added 2 sessions and 5 graph lines\. 1 conflict copy to review\./);
	assert.match(renderToString(<MovedAsideView folders={folders} busy="pre-vault-20261101" done={{}} onMerge={noop} />), /Merging\.\.\./);
});
