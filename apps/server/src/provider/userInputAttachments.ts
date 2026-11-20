import type { ProviderUserInputAnswers, UserInputAttachments } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { placeThreadAttachments, threadAttachmentPath } from "../threadAttachments.ts";
import * as DocumentText from "./DocumentText.ts";

const quoteReference = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/** Keep provider answer protocols unchanged; paths refer to files on the provider's server. */
export const appendUserInputAttachmentPaths = Effect.fn("appendUserInputAttachmentPaths")(
  function* (input: {
    answers: ProviderUserInputAnswers;
    attachmentsByQuestionId?: UserInputAttachments | undefined;
    attachmentsDir: string;
    threadId: string;
  }) {
    const answers = new Map(Object.entries(input.answers));
    const fs = yield* FileSystem.FileSystem;
    const documents = yield* DocumentText.DocumentText;
    for (const [questionId, attachments] of Object.entries(input.attachmentsByQuestionId ?? {})) {
      if (attachments.length === 0) continue;
      const references: string[] = [];
      for (const attachment of attachments) {
        const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
        const stored =
          path !== null && (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)));
        // Extract in the store first so the thread folder gets the sidecar too.
        const extracted = stored && (yield* documents.ensure(path)) !== undefined;
        if (stored) {
          yield* placeThreadAttachments({
            attachmentsDir: input.attachmentsDir,
            threadId: input.threadId,
            attachments: [attachment],
          });
        }
        const threadPath = stored
          ? threadAttachmentPath({
              attachmentsDir: input.attachmentsDir,
              threadId: input.threadId,
              attachment,
            })
          : null;
        // Like a turn's attachments, a missing file is named as unavailable instead of failing.
        if (threadPath === null) {
          references.push(
            `Attached ${attachment.type} ${quoteReference(attachment.name)} is unavailable.`,
          );
          continue;
        }
        const sidecar = `${threadPath}.txt`;
        const copiedText =
          extracted && (yield* fs.exists(sidecar).pipe(Effect.orElseSucceed(() => false)));
        references.push(
          `Attached ${attachment.type} ${quoteReference(attachment.name)}: ${quoteReference(threadPath)}${copiedText ? ` (text extracted to: ${quoteReference(sidecar)})` : ""}`,
        );
      }
      const answer = answers.get(questionId);
      const text = references.join("\n");
      answers.set(
        questionId,
        Array.isArray(answer)
          ? [...answer, text]
          : typeof answer === "string" && answer.length > 0
            ? `${answer}\n\n${text}`
            : text,
      );
    }
    return Object.fromEntries(answers);
  },
);
