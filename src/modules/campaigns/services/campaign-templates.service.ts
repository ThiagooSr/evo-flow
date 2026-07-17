import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { CampaignTemplate } from '../entities/campaign-template.entity';
import { Campaign } from '../entities/campaign.entity';
import { CreateCampaignTemplateDto } from '../dto';
import { TenantDbContext } from '../../../evo-extension-points';
import { CrmClientService } from '../../../shared/crm-client/crm-client.service';

@Injectable()
export class CampaignTemplatesService {
  constructor(
    private readonly db: TenantDbContext,
    private readonly crm: CrmClientService,
  ) {}

  private get campaignTemplateRepository(): Repository<CampaignTemplate> {
    return this.db.getRepository(CampaignTemplate);
  }

  private get campaignRepository(): Repository<Campaign> {
    return this.db.getRepository(Campaign);
  }

  async create(
    campaignId: string,
    createTemplateDto: CreateCampaignTemplateDto,
  ): Promise<CampaignTemplate> {
    // Verify campaign exists
    const campaign = await this.campaignRepository.findOne({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new NotFoundException(`Campaign with ID "${campaignId}" not found`);
    }

    // Verify message template exists and is active. Message templates are
    // owned by evo-ai-crm-community (Meta/WhatsApp template approval lives
    // there) — evo-flow's local `message_templates` table has no migration
    // and nothing populates it, the same abandoned-local-mirror pattern as
    // labels/tags (see SegmentQueryBuilderService#getContactsByTags).
    const payload = await this.crm.get<any>(
      `/api/v1/message_templates/${createTemplateDto.messageTemplateId}`,
    );
    const messageTemplate = payload?.data ?? payload;

    if (!messageTemplate || messageTemplate.active !== true) {
      throw new NotFoundException(
        `Message template with ID "${createTemplateDto.messageTemplateId}" not found or inactive`,
      );
    }

    // Check for duplicate variant
    const existingTemplate = await this.campaignTemplateRepository.findOne({
      where: {
        campaignId,
        messageTemplateId: createTemplateDto.messageTemplateId,
        variant: createTemplateDto.variant || 'A',
      },
    });

    if (existingTemplate) {
      throw new BadRequestException(
        `Template variant "${createTemplateDto.variant || 'A'}" already exists for this campaign and message template`,
      );
    }

    const campaignTemplate = this.campaignTemplateRepository.create({
      campaignId,
      messageTemplateId: createTemplateDto.messageTemplateId,
      variant: createTemplateDto.variant || 'A',
      isWinner: createTemplateDto.isWinner || false,
      statistics: createTemplateDto.statistics || {},
    });

    return this.campaignTemplateRepository.save(campaignTemplate);
  }

  async findAll(campaignId: string): Promise<CampaignTemplate[]> {
    const campaign = await this.campaignRepository.findOne({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new NotFoundException(`Campaign with ID "${campaignId}" not found`);
    }

    return this.campaignTemplateRepository.find({
      where: { campaignId },
      order: { variant: 'ASC' },
    });
  }

  async findOne(id: string, campaignId: string): Promise<CampaignTemplate> {
    const template = await this.campaignTemplateRepository.findOne({
      where: { id, campaignId },
    });

    if (!template) {
      throw new NotFoundException(
        `Campaign template with ID "${id}" not found`,
      );
    }

    return template;
  }

  async remove(id: string, campaignId: string): Promise<void> {
    const template = await this.findOne(id, campaignId);
    await this.campaignTemplateRepository.remove(template);
  }

  async updateStatistics(
    id: string,
    campaignId: string,
    statistics: any,
  ): Promise<CampaignTemplate> {
    const template = await this.findOne(id, campaignId);
    template.statistics = { ...template.statistics, ...statistics };
    return this.campaignTemplateRepository.save(template);
  }

  async setWinner(id: string, campaignId: string): Promise<CampaignTemplate> {
    const template = await this.findOne(id, campaignId);

    // Unset other winners
    await this.campaignTemplateRepository.update(
      { campaignId },
      { isWinner: false },
    );

    // Set this as winner
    template.isWinner = true;
    return this.campaignTemplateRepository.save(template);
  }
}
