import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SendMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(6000)
  content!: string;

  /** Language the content should be written in; sticks to the session when given */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  language?: string;
}
