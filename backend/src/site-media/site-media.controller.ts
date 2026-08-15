import { Body, Controller, Delete, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { SiteMediaService } from './site-media.service';

@Controller('site-media')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class SiteMediaController {
  constructor(private readonly service: SiteMediaService) {}

  @Post('direct-upload')
  createDirectUpload(
    @Body() body: { filename?: string; kind?: string; resourceKey?: string },
    @Req() req: any,
  ) {
    return this.service.createDirectUpload(body, req.user);
  }

  @Post(':id/confirm')
  confirm(@Param('id') id: string, @Body() body: { ref?: string; cor?: string }, @Req() req: any) {
    return this.service.confirm(id, body, req.user);
  }

  @Delete('photo/:photoId')
  remove(@Param('photoId') photoId: string) {
    return this.service.removePhoto(photoId);
  }
}
