import { IsString, IsUrl, MaxLength } from 'class-validator';

export class AddLinkDto {
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(500)
  url!: string;
}
