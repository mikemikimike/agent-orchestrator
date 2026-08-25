import { expect, message, test, turn } from "../support/test";

test.describe("ChatUI interface switching", () => {
	test.describe("MQA-06 failed target-history checkpoint", () => {
		test.use({
			chatUIOptions: {
				mode: "tui",
				provider: "claude-code",
				sessionId: "chatui-history-checkpoint",
			},
		});

		test("offers a retryable, announced action for the interface-switch failure", async ({ chatUI, page }) => {
			chatUI.transitionStatus = {
				supported: true,
				targetMode: "chat",
				transition: {
					id: "transition-history-unsettled",
					sessionId: chatUI.sessionId,
					sourceMode: "tui",
					targetMode: "chat",
					policy: "drain",
					phase: "failed",
					errorCode: "TARGET_HISTORY_UNSETTLED",
					errorDetail: "Interface switch failed (AO-2L): target history is not settled.",
					createdAt: "2026-08-25T09:00:00.000Z",
					updatedAt: "2026-08-25T09:00:01.000Z",
					completedAt: "2026-08-25T09:00:01.000Z",
				},
			};

			await chatUI.open();

			const failure = page.getByText(/Interface switch failed \(AO-2L\)/);
			await expect(failure).toBeVisible();
			const retry = page.getByRole("button", { name: "Retry switch to Chat UI" });
			await Promise.all([
				expect.soft(page.getByRole("alert").filter({ hasText: "AO-2L" })).toBeVisible(),
				expect.soft(retry).toBeVisible(),
			]);
			if ((await retry.count()) === 0) return;
			await retry.click();
			await expect.poll(() => chatUI.requestsMatching("POST", "/interface-transition").length).toBe(1);
			expect(chatUI.requestsMatching("POST", "/interface-transition")[0]?.body).toMatchObject({
				policy: "drain",
				targetMode: "chat",
			});

			chatUI.transitionStatus = {
				supported: true,
				targetMode: "tui",
				transition: {
					id: "transition-requested",
					sessionId: chatUI.sessionId,
					sourceMode: "tui",
					targetMode: "chat",
					policy: "drain",
					phase: "completed",
					createdAt: "2026-08-25T09:00:00.000Z",
					updatedAt: "2026-08-25T09:00:02.000Z",
					completedAt: "2026-08-25T09:00:02.000Z",
				},
			};
			await chatUI.setMode("chat");
			await expect(page.getByRole("region", { name: "Chat" })).toBeVisible();
			expect(chatUI.requestsMatching("POST", "/interface-transition")).toHaveLength(1);
		});
	});

	test.describe("MQA-05 busy Chat to Terminal policy", () => {
		test.use({
			chatUIOptions: {
				activity: "active",
				mode: "chat",
				sessionId: "chatui-busy-switch",
				status: "working",
			},
		});

		test.beforeEach(async ({ chatUI }) => {
			chatUI.conversation = {
				...chatUI.conversation,
				controller: "busy",
				latestSequence: 2,
				oldestSequence: 1,
				turns: [
					turn("turn-running", "running"),
					turn("turn-queued", "queued"),
				],
				messages: [
					message("message-running", "turn-running", 1, "user", "Finish the active task"),
					message("message-queued", "turn-queued", 2, "user", "Then check the queued task"),
				],
			};
		});

		test("offers Finish work before submitting the non-destructive drain policy", async ({ chatUI, page }) => {
			await chatUI.open();
			await page.getByRole("button", { name: "Switch to terminal UI" }).click();

			const dialog = page.getByRole("dialog", { name: "Switch to Terminal UI?" });
			await expect(dialog).toBeVisible();
			expect(chatUI.requestsMatching("POST", "/interface-transition")).toHaveLength(0);
			await dialog.getByRole("button", { name: "Finish work, then switch" }).click();

			await expect.poll(() => chatUI.requestsMatching("POST", "/interface-transition").length).toBe(1);
			expect(chatUI.requestsMatching("POST", "/interface-transition")[0]?.body).toMatchObject({
				policy: "drain",
				targetMode: "tui",
			});
		});

		test("maps explicit Stop now consent to the destructive interrupt policy", async ({ chatUI, page }) => {
			await chatUI.open();
			await page.getByRole("button", { name: "Switch to terminal UI" }).click();

			const dialog = page.getByRole("dialog", { name: "Switch to Terminal UI?" });
			await expect(dialog).toBeVisible();
			expect(chatUI.requestsMatching("POST", "/interface-transition")).toHaveLength(0);
			await dialog.getByRole("button", { name: "Stop now and switch" }).click();

			await expect.poll(() => chatUI.requestsMatching("POST", "/interface-transition").length).toBe(1);
			expect(chatUI.requestsMatching("POST", "/interface-transition")[0]?.body).toMatchObject({
				policy: "interrupt",
				targetMode: "tui",
			});
		});
	});

	test.describe("MQA-04 composer durability", () => {
		const secondarySessionId = "chatui-draft-round-trip-secondary";
		test.use({
			chatUIOptions: {
				secondarySessionId,
				sessionId: "chatui-draft-round-trip",
			},
		});

		test("keeps drafts session-scoped across interface, navigation, reload, and accepted send", async ({ chatUI, page }) => {
			const primaryDraft = "draft-survives-interface-round-trip-1e67";
			const secondaryDraft = "secondary-session-draft-75c4";
			await chatUI.open();
			await page.getByRole("combobox", { name: "Message the agent" }).fill(primaryDraft);

			await chatUI.setMode("tui");
			await expect(page.getByRole("region", { name: "Chat" })).toHaveCount(0);
			await expect(page.getByTestId("terminal-interaction-surface")).toBeVisible();
			await chatUI.setMode("chat");

			let composer = page.getByRole("combobox", { name: "Message the agent" });
			await expect(composer).toBeVisible();
			await expect(composer, "draft after full Chat surface unmount").toHaveText(primaryDraft);

			await chatUI.navigateToSession(secondarySessionId);
			composer = page.getByRole("combobox", { name: "Message the agent" });
			await expect(composer, "primary draft must not leak into a second session").not.toContainText(primaryDraft);
			await composer.fill(secondaryDraft);

			await chatUI.navigateToSession(chatUI.sessionId);
			composer = page.getByRole("combobox", { name: "Message the agent" });
			await expect(composer, "primary draft after session navigation").toHaveText(primaryDraft);
			await expect(composer, "secondary draft must remain session-scoped").not.toContainText(secondaryDraft);

			await page.reload();
			await expect(page.getByRole("region", { name: "Chat" })).toBeVisible();
			composer = page.getByRole("combobox", { name: "Message the agent" });
			await expect(composer, "primary draft after renderer reload").toHaveText(primaryDraft);

			await chatUI.navigateToSession(secondarySessionId);
			composer = page.getByRole("combobox", { name: "Message the agent" });
			await expect(composer, "secondary draft survives independently").toHaveText(secondaryDraft);

			await page.getByRole("button", { name: "Send message" }).click();
			await expect.poll(() => chatUI.requestsMatching("POST", "/conversation/messages").length).toBe(1);
			await expect(composer, "an accepted send clears only the submitted session draft").toHaveText("");

			await chatUI.navigateToSession(chatUI.sessionId);
			await expect
				(page.getByRole("combobox", { name: "Message the agent" }), "sending the secondary draft preserves the primary draft")
				.toHaveText(primaryDraft);
			await chatUI.navigateToSession(secondarySessionId);
			await expect(page.getByRole("combobox", { name: "Message the agent" })).toHaveText("");
			await page.reload();
			await expect(page.getByRole("combobox", { name: "Message the agent" }), "accepted draft must not resurrect after reload").toHaveText("");
		});

		test("keeps an inline edit independent and cancellation preserves the composer", async ({ chatUI, page }) => {
			const composerDraft = "independent-composer-draft-f3b1";
			const inlineDraft = "persisted-inline-edit-55d9";
			chatUI.conversation = {
				...chatUI.conversation,
				latestSequence: 1,
				oldestSequence: 1,
				turns: [turn("turn-editable", "completed", { providerTurnId: "provider-turn-editable" })],
				messages: [
					message("message-editable", "turn-editable", 1, "user", "Original user prompt", {
						editAvailable: true,
					}),
				],
			};

			await chatUI.open();
			const composer = page.getByRole("combobox", { name: "Message the agent" });
			await composer.fill(composerDraft);
			await page.getByRole("button", { name: "Edit user message" }).click();
			const editor = page.getByRole("textbox", { name: "Edit message" });
			await editor.fill(inlineDraft);

			await chatUI.setMode("tui");
			await expect(page.getByTestId("terminal-interaction-surface")).toBeVisible();
			await chatUI.setMode("chat");
			await expect(page.getByRole("textbox", { name: "Edit message" })).toHaveValue(inlineDraft);
			await expect(page.getByRole("combobox", { name: "Message the agent" })).toHaveText(composerDraft);

			await page.getByRole("textbox", { name: "Edit message" }).press("Escape");
			await expect(page.getByRole("textbox", { name: "Edit message" })).toHaveCount(0);
			await expect(page.getByRole("combobox", { name: "Message the agent" })).toHaveText(composerDraft);

			await page.reload();
			await expect(page.getByRole("textbox", { name: "Edit message" }), "cancelled inline edit must not resurrect").toHaveCount(0);
			await expect(page.getByRole("combobox", { name: "Message the agent" }), "cancelling an inline edit must not clear the composer").toHaveText(composerDraft);
		});

		test("restores only durable attachment descriptors and clears them after acceptance", async ({ chatUI, page }) => {
			await chatUI.open();
			await page.locator('input[type="file"]').setInputFiles({
				name: "durable-regression.png",
				mimeType: "image/png",
				buffer: Buffer.from("durable-attachment-evidence"),
			});

			await expect(page.getByRole("button", { name: "Remove durable-regression.png" })).toBeVisible();
			await expect.poll(() => chatUI.requestsMatching("POST", "/attachments").length).toBe(1);

			await page.reload();
			await expect(page.getByRole("button", { name: "Remove durable-regression.png" }), "durably staged attachment after reload").toBeVisible();
			await page.getByRole("combobox", { name: "Message the agent" }).fill("Inspect the restored attachment");
			await page.getByRole("button", { name: "Send message" }).click();

			await expect.poll(() => chatUI.requestsMatching("POST", "/conversation/messages").length).toBe(1);
			expect(chatUI.requestsMatching("POST", "/attachments")).toHaveLength(1);
			const sent = chatUI.requestsMatching("POST", "/conversation/messages")[0]?.body as Record<string, unknown>;
			expect(String(sent.text ?? "")).toContain(".ao/attachments/attachment-regression.png");
			await expect(page.getByRole("button", { name: "Remove durable-regression.png" })).toHaveCount(0);

			await page.reload();
			await expect(page.getByRole("button", { name: "Remove durable-regression.png" }), "accepted attachment must not resurrect").toHaveCount(0);
		});

		test("reload during an unresolved send stays fail-closed and retries with the same id", async ({ chatUI, page }) => {
			chatUI.deferNextMessageResponse();
			try {
				await chatUI.open();
				const composer = page.getByRole("combobox", { name: "Message the agent" });
				await composer.fill("crash-safe delivery");
				await page.getByRole("button", { name: "Send message" }).click();
				await expect.poll(() => chatUI.requestsMatching("POST", "/conversation/messages").length).toBe(1);

				await page.reload();
				await expect(page.getByRole("region", { name: "Chat" })).toBeVisible();
				await expect(page.getByRole("combobox", { name: "Message the agent" })).toHaveText(
					"crash-safe delivery",
				);
				await expect(page.getByRole("combobox", { name: "Message the agent" })).toHaveAttribute(
					"contenteditable",
					"false",
				);
				await expect(page.getByRole("alert")).toContainText(
					"delivery wasn’t confirmed before Chat restarted",
				);
				await expect(page.getByRole("button", { name: "Retry message safely" })).toBeEnabled();
				expect(chatUI.requestsMatching("POST", "/conversation/messages")).toHaveLength(1);

				chatUI.releaseDeferredMessageResponse();
				await page.getByRole("button", { name: "Retry message safely" }).click();
				await expect.poll(() => chatUI.requestsMatching("POST", "/conversation/messages").length).toBe(2);
				const attempts = chatUI.requestsMatching("POST", "/conversation/messages");
				expect((attempts[0]?.body as Record<string, unknown>).clientMessageId).toBe(
					(attempts[1]?.body as Record<string, unknown>).clientMessageId,
				);
				await expect(page.getByRole("combobox", { name: "Message the agent" })).toHaveText("");
			} finally {
				chatUI.releaseDeferredMessageResponse();
			}
		});

		test("accepted send with failed removal never redispatches after reload", async ({ chatUI, page }) => {
			await page.addInitScript(() => {
				const state = window as typeof window & { __aoFailDraftRemoval?: boolean };
				state.__aoFailDraftRemoval = true;
				const originalRemove = Storage.prototype.removeItem;
				Storage.prototype.removeItem = function removeItemWithDraftFailure(key: string) {
					if (state.__aoFailDraftRemoval && key.startsWith("ao.chat.draft:")) {
						throw new DOMException("blocked", "SecurityError");
					}
					return originalRemove.call(this, key);
				};
			});

			await chatUI.open();
			await page.getByRole("combobox", { name: "Message the agent" }).fill("accepted exactly once");
			await page.getByRole("button", { name: "Send message" }).click();
			await expect.poll(() => chatUI.requestsMatching("POST", "/conversation/messages").length).toBe(1);
			await expect(page.getByRole("button", { name: "Finish clearing accepted message" })).toBeEnabled();

			await page.reload();
			await expect(page.getByRole("button", { name: "Finish clearing accepted message" })).toBeEnabled();
			await expect(page.getByRole("alert")).toContainText("local draft couldn’t be cleared");
			expect(chatUI.requestsMatching("POST", "/conversation/messages")).toHaveLength(1);

			await page.evaluate(() => {
				(window as typeof window & { __aoFailDraftRemoval?: boolean }).__aoFailDraftRemoval = false;
			});
			await page.getByRole("button", { name: "Finish clearing accepted message" }).click();
			await expect(page.getByRole("combobox", { name: "Message the agent" })).toHaveText("");
			expect(chatUI.requestsMatching("POST", "/conversation/messages")).toHaveLength(1);
		});

		test("reload during an unresolved inline edit stays fail-closed and reuses its id", async ({ chatUI, page }) => {
			chatUI.conversation = {
				...chatUI.conversation,
				latestSequence: 1,
				oldestSequence: 1,
				turns: [turn("turn-edit-reload", "completed", { providerTurnId: "provider-edit-reload" })],
				messages: [
					message("message-edit-reload", "turn-edit-reload", 1, "user", "Original edit target", {
						editAvailable: true,
					}),
				],
			};
			chatUI.deferNextEditResponse();
			try {
				await chatUI.open();
				await page.getByRole("button", { name: "Edit user message" }).click();
				const editor = page.getByRole("textbox", { name: "Edit message" });
				await editor.fill("crash-safe inline edit");
				await page.getByRole("button", { name: "Send edited message" }).click();
				await expect.poll(() => chatUI.requestsMatching("POST", "/edit").length).toBe(1);

				await page.reload();
				await expect(page.getByRole("textbox", { name: "Edit message" })).toHaveValue(
					"crash-safe inline edit",
				);
				await expect(page.getByRole("textbox", { name: "Edit message" })).toBeDisabled();
				await expect(page.getByRole("alert")).toContainText(
					"delivery wasn’t confirmed before Chat restarted",
				);
				await expect(page.getByRole("button", { name: "Retry edit safely" })).toBeEnabled();
				expect(chatUI.requestsMatching("POST", "/edit")).toHaveLength(1);

				chatUI.releaseDeferredEditResponse();
				await page.getByRole("button", { name: "Retry edit safely" }).click();
				await expect.poll(() => chatUI.requestsMatching("POST", "/edit").length).toBe(2);
				const attempts = chatUI.requestsMatching("POST", "/edit");
				expect((attempts[0]?.body as Record<string, unknown>).clientMessageId).toBe(
					(attempts[1]?.body as Record<string, unknown>).clientMessageId,
				);
				await expect(page.getByRole("textbox", { name: "Edit message" })).toHaveCount(0);
			} finally {
				chatUI.releaseDeferredEditResponse();
			}
		});

		test("accepted inline edit with failed removal never redispatches after reload", async ({ chatUI, page }) => {
			chatUI.conversation = {
				...chatUI.conversation,
				latestSequence: 1,
				oldestSequence: 1,
				turns: [turn("turn-edit-clear", "completed", { providerTurnId: "provider-edit-clear" })],
				messages: [
					message("message-edit-clear", "turn-edit-clear", 1, "user", "Original clear target", {
						editAvailable: true,
					}),
				],
			};
			await page.addInitScript(() => {
				const state = window as typeof window & { __aoFailInlineDraftRemoval?: boolean };
				state.__aoFailInlineDraftRemoval = true;
				const originalRemove = Storage.prototype.removeItem;
				Storage.prototype.removeItem = function removeItemWithInlineDraftFailure(key: string) {
					if (state.__aoFailInlineDraftRemoval && key.startsWith("ao.chat.draft:")) {
						throw new DOMException("blocked", "SecurityError");
					}
					return originalRemove.call(this, key);
				};
			});

			await chatUI.open();
			await page.getByRole("button", { name: "Edit user message" }).click();
			await page.getByRole("textbox", { name: "Edit message" }).fill("accepted inline once");
			await page.getByRole("button", { name: "Send edited message" }).click();
			await expect.poll(() => chatUI.requestsMatching("POST", "/edit").length).toBe(1);
			await expect(page.getByRole("button", { name: "Finish clearing accepted edit" })).toBeEnabled();

			await page.reload();
			await expect(page.getByRole("button", { name: "Finish clearing accepted edit" })).toBeEnabled();
			await expect(page.getByRole("alert")).toContainText("local draft couldn’t be cleared");
			expect(chatUI.requestsMatching("POST", "/edit")).toHaveLength(1);

			await page.evaluate(() => {
				(window as typeof window & { __aoFailInlineDraftRemoval?: boolean }).__aoFailInlineDraftRemoval = false;
			});
			await page.getByRole("button", { name: "Finish clearing accepted edit" }).click();
			await expect(page.getByRole("textbox", { name: "Edit message" })).toHaveCount(0);
			expect(chatUI.requestsMatching("POST", "/edit")).toHaveLength(1);
		});

		test("typed steer refusal unlocks only its session draft and never redispatches after reload", async ({ chatUI, page }) => {
			chatUI.conversation = {
				...chatUI.conversation,
				controller: "busy",
				latestSequence: 1,
				oldestSequence: 1,
				turns: [turn("turn-refused-steer", "running", { providerTurnId: "provider-refused-steer" })],
				messages: [
					message("message-refused-steer", "turn-refused-steer", 1, "user", "Original running task"),
				],
			};
			chatUI.refuseNextSteer(
				"CHAT_NO_ACTIVE_TURN",
				"there is no turn in flight to steer; send this as a message instead",
			);

			await chatUI.open();
			const composer = page.getByRole("combobox", { name: "Message the agent" });
			await composer.fill("send this normally instead");
			await composer.press("Control+Enter");
			await expect.poll(() => chatUI.requestsMatching("POST", "/conversation/steer").length).toBe(1);

			await expect(composer).toHaveText("send this normally instead");
			await expect(composer).toHaveAttribute("contenteditable", "true");
			await expect(page.getByText(/Send it as a message instead/)).toBeVisible();
			await expect(page.getByRole("button", { name: "Retry message safely" })).toHaveCount(0);
			const draftKey = `ao.chat.draft:${encodeURIComponent(chatUI.sessionId)}`;
			await expect
				.poll(() =>
					page.evaluate((key) => {
						const raw = localStorage.getItem(key);
						return raw ? JSON.parse(raw) : null;
					}, draftKey),
				)
				.toMatchObject({
					sessionId: chatUI.sessionId,
					composer: { text: "send this normally instead" },
				});
			expect(
				await page.evaluate((key) => {
					const raw = localStorage.getItem(key);
					return raw ? JSON.parse(raw).composer.delivery : undefined;
				}, draftKey),
			).toBeUndefined();

			await chatUI.navigateToSession(secondarySessionId);
			await expect(page.getByRole("combobox", { name: "Message the agent" })).toHaveText("");
			await chatUI.navigateToSession(chatUI.sessionId);
			await page.reload();
			await expect(page.getByRole("combobox", { name: "Message the agent" })).toHaveText(
				"send this normally instead",
			);
			await expect(page.getByRole("combobox", { name: "Message the agent" })).toHaveAttribute(
				"contenteditable",
				"true",
			);
			await expect(page.getByRole("button", { name: "Retry message safely" })).toHaveCount(0);
			expect(chatUI.requestsMatching("POST", "/conversation/steer")).toHaveLength(1);
		});

		test("reload reconciles a durable steer from conversation history without redispatch", async ({ chatUI, page }) => {
			chatUI.conversation = {
				...chatUI.conversation,
				latestSequence: 1,
				oldestSequence: 1,
				turns: [turn("turn-running-steer", "running", { providerTurnId: "provider-running-steer" })],
				messages: [
					message("message-running-steer", "turn-running-steer", 1, "user", "Original running task"),
				],
			};
			chatUI.deferNextSteerResponse();
			try {
				await chatUI.open();
				const composer = page.getByRole("combobox", { name: "Message the agent" });
				await composer.fill("snapshot-confirmed guidance");
				await composer.press("Control+Enter");
				await expect.poll(() => chatUI.requestsMatching("POST", "/conversation/steer").length).toBe(1);
				const clientMessageId = String(
					(chatUI.requestsMatching("POST", "/conversation/steer")[0]?.body as Record<string, unknown>)
						.clientMessageId ?? "",
				);
				expect(clientMessageId).not.toBe("");
				chatUI.conversation.activities = [
					{
						kind: "activity",
						id: "activity-confirmed-steer",
						turnId: "turn-running-steer",
						sequence: 2,
						revision: 0,
						activityKind: "system",
						status: "completed",
						summary: "snapshot-confirmed guidance",
						detail: {
							event: "steer",
							origin: "human",
							clientMessageId,
						},
						createdAt: "2026-08-25T09:00:00.000Z",
					},
				];
				chatUI.conversation.latestSequence = 2;
				const draftKey = `ao.chat.draft:${encodeURIComponent(chatUI.sessionId)}`;
				await expect
					.poll(() =>
						page.evaluate((key) => {
							const raw = localStorage.getItem(key);
							return raw ? JSON.parse(raw) : null;
						}, draftKey),
					)
					.toMatchObject({
						composer: {
							delivery: { clientMessageId, kind: "steer", state: "dispatching" },
						},
					});

				await page.reload();
				await expect
					.poll(() => page.evaluate((key) => localStorage.getItem(key), draftKey))
					.toBeNull();
				await expect(page.getByRole("combobox", { name: "Message the agent" })).toHaveText("");
				await expect(page.getByRole("button", { name: "Retry message safely" })).toHaveCount(0);
				expect(chatUI.requestsMatching("POST", "/conversation/steer")).toHaveLength(1);
			} finally {
				chatUI.releaseDeferredSteerResponse();
			}
		});
	});

	test.describe("MQA-08 imported Terminal outcome", () => {
		test.use({ chatUIOptions: { sessionId: "chatui-imported-outcome" } });

		test("uses a neutral imported-history label when completion metadata is unavailable", async ({ chatUI, page }) => {
			chatUI.conversation = {
				...chatUI.conversation,
				latestSequence: 2,
				oldestSequence: 1,
				turns: [turn("turn-imported", "recovered", { providerTurnId: "native-turn-1" })],
				messages: [
					message("message-imported-user", "turn-imported", 1, "user", "Run the native task"),
					message("message-imported-assistant", "turn-imported", 2, "assistant", "Native task output imported"),
				],
			};

			await chatUI.open();

			await expect.soft(
				page.getByText("Imported from Terminal UI — completion status unavailable", { exact: true }),
			).toBeVisible();
			await expect.soft(page.getByText("Outcome unknown", { exact: true })).toHaveCount(0);
		});
	});
});
