/** The notice shown for a question this device did not ask (components/other-device-question.tsx). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OtherDeviceQuestionNotice } from "../components/other-device-question.tsx";

test("the notice says what allowing means and shows the question's data as text", () => {
	const html = renderToStaticMarkup(<OtherDeviceQuestionNotice chatId="chat_1" id="q-1" onAllowed={() => {}}
		details={{ payload: { tests: { program: "sh", args: ["-s"], code: "<script>alert(1)</script>" } } }} />);
	assert.match(html, /not asked on this device/);
	assert.match(html, /can start programs/);
	assert.match(html, /Allow checks on this device/);
	assert.match(html, /&quot;program&quot;: &quot;sh&quot;/, "the test recipe is visible");
	assert.ok(!html.includes("<script>"), "question data is text, never markup");
});
