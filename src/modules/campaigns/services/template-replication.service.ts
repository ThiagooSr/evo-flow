import { Injectable, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CampaignTemplate } from '../entities/campaign-template.entity';
import { MessageTemplate } from '../../../shared/entities/message-template.entity';
import { TenantDbContext } from '../../../evo-extension-points';

export interface TemplateConfig {
  messageTemplateId: string;
  variant?: string; // 'A', 'B', 'C' for A/B testing
}

@Injectable()
export class TemplateReplicationService {
  constructor(private readonly db: TenantDbContext) {}

  private get campaignTemplateRepo(): Repository<CampaignTemplate> {
    return this.db.getRepository(CampaignTemplate);
  }

  private get messageTemplateRepo(): Repository<MessageTemplate> {
    return this.db.getRepository(MessageTemplate);
  }

  /**
   * Add multiple templates to a campaign
   * Useful for A/B testing or campaigns with multiple variations
   */
  async addTemplatesToCampaign(
    campaignId: string,
    templates: TemplateConfig[],
  ): Promise<CampaignTemplate[]> {
    // Validate that the templates exist in evo-ai-crm
    const templateIds = templates.map((t) => t.messageTemplateId);
    const existingTemplates = await this.messageTemplateRepo.find({
      where: templateIds.map((id) => ({ id, active: true })),
    });

    if (existingTemplates.length !== templateIds.length) {
      const foundIds = existingTemplates.map((t) => t.id);
      const missingIds = templateIds.filter((id) => !foundIds.includes(id));
      throw new NotFoundException(
        `Some message templates not found or inactive: ${missingIds.join(', ')}`,
      );
    }

    const entities = templates.map((config, index) => {
      const entity = new CampaignTemplate();
      entity.campaignId = campaignId;
      entity.messageTemplateId = config.messageTemplateId;
      entity.variant = config.variant || String.fromCharCode(65 + index);
      entity.statistics = {};
      return entity;
    });

    return this.campaignTemplateRepo.save(entities);
  }

  /**
   * Get templates from a campaign with complete message_template data
   */
  async getCampaignTemplatesWithData(campaignId: string): Promise<any[]> {
    const campaignTemplates = await this.campaignTemplateRepo.find({
      where: { campaignId },
    });

    const templatesWithData = await Promise.all(
      campaignTemplates.map(async (ct) => {
        const messageTemplate = await this.messageTemplateRepo.findOne({
          where: { id: ct.messageTemplateId },
        });

        return {
          ...ct,
          templateData: messageTemplate,
        };
      }),
    );

    return templatesWithData;
  }

  /**
   * Update statistics of a template in the campaign (for A/B testing)
   */
  async updateTemplateStatistics(
    campaignTemplateId: string,
    statistics: any,
  ): Promise<CampaignTemplate> {
    const campaignTemplate = await this.campaignTemplateRepo.findOne({
      where: { id: campaignTemplateId },
    });

    if (!campaignTemplate) {
      throw new NotFoundException('Campaign template not found');
    }

    campaignTemplate.statistics = {
      ...campaignTemplate.statistics,
      ...statistics,
    };

    return this.campaignTemplateRepo.save(campaignTemplate);
  }

  /**
   * Mark template winner in A/B testing
   */
  async setWinnerTemplate(campaignTemplateId: string): Promise<void> {
    const campaignTemplate = await this.campaignTemplateRepo.findOne({
      where: { id: campaignTemplateId },
    });

    if (!campaignTemplate) {
      throw new NotFoundException('Campaign template not found');
    }

    // Unset other templates as winners
    await this.campaignTemplateRepo.update(
      { campaignId: campaignTemplate.campaignId },
      { isWinner: false },
    );

    // Mark this as winner
    campaignTemplate.isWinner = true;
    await this.campaignTemplateRepo.save(campaignTemplate);
  }
}
