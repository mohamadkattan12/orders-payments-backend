import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export const MAX_QTY = 20;
export const MAX_LINES = 20;

class CustomerDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @Matches(/^\+9665\d{8}$/, {
    message: 'phone must be a Saudi mobile number like +966512345678',
  })
  phone!: string;

  @IsString()
  @Length(1, 60)
  city!: string;
}

class LineDto {
  @IsString()
  @Length(1, 64)
  sku!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_QTY)
  qty!: number;
}

export class CheckoutDto {
  @ValidateNested()
  @Type(() => CustomerDto)
  customer!: CustomerDto;

  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINES)
  @ArrayUnique((line: LineDto) => line.sku, {
    message: 'each SKU may appear once',
  })
  @ValidateNested({ each: true })
  @Type(() => LineDto)
  items!: LineDto[];
}
