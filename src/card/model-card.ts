import { modelLabel, supportedModels } from '../agent/models';
import type { AgentKind } from '../config/profile-schema';

export interface ModelPickerOpts {
  agentKind: AgentKind;
  /** Current model selection. */
  model: string;
  /** Optional model options (defaults to supportedModels catalog). */
  options?: Array<{ value: string; label: string }>;
}

/**
 * A compact card with a single model selector and submit / cancel buttons.
 * Submitted via card callback payload `{ cmd: 'model.submit' }`.
 *
 * Mirrors the CardKit 2.0 form structure from configFormCard: the select and
 * buttons live inside a `{ tag: 'form' }` wrapper — putting them directly in
 * `body.elements` made `cardkit.create` fail with "returned no card_id".
 */
export function modelPickerCard(opts: ModelPickerOpts): object {
  const options = (opts.options ?? supportedModels(opts.agentKind)).map((m) => ({
    text: { tag: 'plain_text', content: m.label },
    value: m.value,
  }));

  return {
    schema: '2.0',
    config: { summary: { content: '切换模型' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `当前模型：\`${modelLabel(opts.agentKind, opts.model)}\``,
        },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'model_form',
          elements: [
            {
              tag: 'markdown',
              content:
                '_底层 agent 运行使用的模型_\n' +
                '_「跟随默认」= 不指定，由 CLI / 账号决定_',
            },
            {
              tag: 'select_static',
              name: 'model',
              initial_option: opts.model,
              options,
            },
            { tag: 'hr' },
            {
              tag: 'column_set',
              columns: [
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'submit_btn',
                      text: { tag: 'plain_text', content: '切换' },
                      type: 'primary',
                      form_action_type: 'submit',
                      behaviors: [{ type: 'callback', value: { cmd: 'model.submit' } }],
                    },
                  ],
                },
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'cancel_btn',
                      text: { tag: 'plain_text', content: '取消' },
                      behaviors: [{ type: 'callback', value: { cmd: 'model.cancel' } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}