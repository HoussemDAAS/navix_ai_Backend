import { IsString, MinLength, MaxLength } from 'class-validator';

export class AddCompetitorDto {
  /** Full profile link (instagram.com/…, tiktok.com/@…) or a bare @handle */
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  link: string;
}
