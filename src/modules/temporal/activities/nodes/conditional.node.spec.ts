import { ConditionalNode, ConditionalNodeInput } from './conditional.node';

const mockGetConversation = jest.fn();
jest.mock('../../../../shared/crm-client/crm-client.service', () => ({
  CrmClientService: jest.fn().mockImplementation(() => ({
    getConversation: mockGetConversation,
  })),
}));

describe('ConditionalNode — {{conversation.pipeline_stage_id}}', () => {
  let node: ConditionalNode;

  const STAGE_X = 'stage-x-uuid';
  const STAGE_Y = 'stage-y-uuid';

  const inputWith = (
    operator: 'equals' | 'not_equals',
    value: string,
  ): ConditionalNodeInput => ({
    nodeId: 'n1',
    contactId: 'c1',
    conversationId: 'conv-1',
    sessionId: 's1',
    nodeData: {
      paths: [
        {
          id: 'p1',
          name: 'Stage path',
          conditions: [
            {
              id: 'cond-1',
              // `custom` on purpose: conversation fields are resolved by field
              // pattern, independent of the condition type.
              type: 'custom',
              field: '{{conversation.pipeline_stage_id}}',
              operator,
              value,
            },
          ],
          logicalOperator: 'AND',
        },
      ],
    },
  });

  const conversationInStages = (...stageIds: string[]) => ({
    pipelines: stageIds.map((id, i) => ({
      id: `pl-${i}`,
      name: `Pipeline ${i}`,
      stages: [{ id, name: id }],
    })),
  });

  beforeEach(() => {
    node = new ConditionalNode();

    jest
      .spyOn(node as any, 'selectiveInterpolateNodeData')
      .mockImplementation(async (_input, nodeData) => nodeData);
    jest.spyOn(node as any, 'loadContactData').mockResolvedValue({});
    jest.spyOn(node as any, 'loadSessionVariables').mockResolvedValue({});

    jest.spyOn((node as any).logger, 'log').mockImplementation(() => undefined);
    jest
      .spyOn((node as any).logger, 'warn')
      .mockImplementation(() => undefined);
    jest
      .spyOn((node as any).logger, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockGetConversation.mockReset();
  });

  it('equals: matches when the conversation is currently in stage X', async () => {
    jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue(conversationInStages(STAGE_X));

    const result = await node.execute(inputWith('equals', STAGE_X));

    expect(result.success).toBe(true);
    expect((result as any).nextNodeHandle).toBe('p1');
  });

  it('equals: does not match when the conversation is in a different stage', async () => {
    jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue(conversationInStages(STAGE_Y));

    const result = await node.execute(inputWith('equals', STAGE_X));

    expect((result as any).nextNodeHandle).toBe('else');
  });

  it('not_equals: does not match when the conversation is in stage X', async () => {
    jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue(conversationInStages(STAGE_X));

    const result = await node.execute(inputWith('not_equals', STAGE_X));

    expect((result as any).nextNodeHandle).toBe('else');
  });

  it('not_equals: matches when the conversation is in a different stage', async () => {
    jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue(conversationInStages(STAGE_Y));

    const result = await node.execute(inputWith('not_equals', STAGE_X));

    expect((result as any).nextNodeHandle).toBe('p1');
  });

  it('multi-pipeline: matches when ANY pipeline is currently in stage X', async () => {
    jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue(conversationInStages('other-stage', STAGE_X));

    const result = await node.execute(inputWith('equals', STAGE_X));

    expect((result as any).nextNodeHandle).toBe('p1');
  });

  it('null-safety: no conversation in scope → equals is false, no crash', async () => {
    jest.spyOn(node as any, 'loadConversationData').mockResolvedValue(null);

    const result = await node.execute(inputWith('equals', STAGE_X));

    expect(result.success).toBe(true);
    expect((result as any).nextNodeHandle).toBe('else');
  });

  it('null-safety: conversation without pipeline items → equals is false', async () => {
    jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue({ pipelines: [] });

    const result = await node.execute(inputWith('equals', STAGE_X));

    expect((result as any).nextNodeHandle).toBe('else');
  });

  it('no target stage selected → never matches, even with not_equals', async () => {
    jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue(conversationInStages(STAGE_X));

    const result = await node.execute(inputWith('not_equals', ''));

    expect((result as any).nextNodeHandle).toBe('else');
  });

  it('does not load conversation data when no condition uses a conversation field', async () => {
    const loadSpy = jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue(null);

    const contactInput: ConditionalNodeInput = {
      nodeId: 'n1',
      contactId: 'c1',
      conversationId: 'conv-1',
      sessionId: 's1',
      nodeData: {
        paths: [
          {
            id: 'p1',
            name: 'Contact path',
            conditions: [
              {
                id: 'cond-1',
                type: 'contact',
                field: '{{contact.email}}',
                operator: 'equals',
                value: 'a@b.com',
              },
            ],
            logicalOperator: 'AND',
          },
        ],
      },
    };

    await node.execute(contactInput);

    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('integration: resolves the stage through the real loadConversationData, unwrapping the success_response envelope', async () => {
    // No loadConversationData spy here — exercise the real seam. getConversation
    // returns the CRM envelope ({ success, data: <conversation>, meta }) wrapped
    // by executeRequest as CrmApiResponse.data, so the stage lives at data.data.
    const conversationBody = {
      success: true,
      data: {
        pipelines: [{ id: 'pl1', name: 'Sales', stages: [{ id: STAGE_X }] }],
      },
      meta: {},
    };
    mockGetConversation.mockResolvedValue({
      success: true,
      data: conversationBody,
    });

    const result = await node.execute(inputWith('equals', STAGE_X));

    expect(mockGetConversation).toHaveBeenCalledWith({
      conversationId: 'conv-1',
    });
    expect((result as any).nextNodeHandle).toBe('p1');
  });
});
