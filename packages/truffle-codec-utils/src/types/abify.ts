import debugModule from "debug";
const debug = debugModule("codec-utils:types:abify");

import { Types } from "./types";
import { Values } from "./values";
import { Errors } from "./errors";
import { UnknownUserDefinedTypeError } from "../errors";
import BN from "bn.js";
import { Conversion as ConversionUtils } from "../conversion";

export function abifyType(dataType: Types.Type, userDefinedTypes?: Types.TypesById): Types.Type | undefined {
  switch(dataType.typeClass) {
    //we only need to specially handle types that don't go in
    //the ABI, or that have some information loss when going
    //in the ABI
    //note that we do need to handle arrays, due to recursion!
    //First: types that do not go in the ABI
    case "mapping":
    case "magic":
      return undefined;
    //Next: address & contract, these can get handled together
    case "address":
    case "contract":
      return {
        typeClass: "address",
        kind: "general",
        typeHint: Types.typeString(dataType)
      };
    case "function":
      switch(dataType.visibility) {
        case "external":
          return {
            typeClass: "function",
            visibility: "external",
            kind: "general",
            typeHint: Types.typeString(dataType)
          };
        case "internal": //these don't go in the ABI
          return undefined;
      }
      break; //to satisfy TypeScript
    //the complex cases: struct & enum
    case "struct": {
      const fullType = <Types.StructType> Types.fullType(dataType, userDefinedTypes);
      if(!fullType) {
        let typeToDisplay = Types.typeString(dataType);
        throw new UnknownUserDefinedTypeError(dataType.id, typeToDisplay);
      }
      const memberTypes = fullType.memberTypes.map(
        ({name, type: memberType}) => ({
          name,
          type: abifyType(memberType, userDefinedTypes)
        })
      );
      return {
        typeClass: "tuple",
        typeHint: Types.typeString(fullType),
        memberTypes
      };
    }
    case "enum": {
      const fullType = <Types.EnumType> Types.fullType(dataType, userDefinedTypes);
      if(!fullType) {
        let typeToDisplay = Types.typeString(dataType);
        throw new UnknownUserDefinedTypeError(dataType.id, typeToDisplay);
      }
      let numOptions = fullType.options.length;
      let bits = 8 * Math.ceil(Math.log2(numOptions) / 8);
      return {
        typeClass: "uint",
        bits,
        typeHint: Types.typeString(fullType)
      };
    }
    //finally: arrays
    case "array":
      return {
        ...dataType,
        typeHint: Types.typeString(dataType),
        baseType: abifyType(dataType.baseType, userDefinedTypes)
      };
    //default case: just leave as-is
    default:
      return dataType;
  }
}

export function abifyResult(result: Values.Result, userDefinedTypes?: Types.TypesById): Values.Result | undefined {
  switch(result.type.typeClass) {
    case "mapping": //doesn't go in ABI
    case "magic": //doesn't go in ABI
      return undefined;
    case "address":
      //abify the type but leave the value alone
      return {
        ...<Values.AddressResult> result,
        type: <Types.AddressType> abifyType(result.type, userDefinedTypes)
      };
    case "contract": {
      let coercedResult = <Values.ContractResult> result;
      switch(coercedResult.kind) {
        case "value":
          return {
            type: <Types.AddressType> abifyType(result.type, userDefinedTypes),
            kind: "value",
            value: {
              asAddress: coercedResult.value.address,
              rawAsHex: coercedResult.value.rawAddress
            }
          };
        case "error":
          switch(coercedResult.error.kind) {
            case "ContractPaddingError":
              return {
                type: <Types.AddressType> abifyType(result.type, userDefinedTypes),
                kind: "error",
                error: {
                  kind: "AddressPaddingError",
                  raw: coercedResult.error.raw
                }
              };
            default:
              //other contract errors are generic errors!
              //but TS doesn't know this so we coerce
              return <Errors.AddressErrorResult> {
                ...coercedResult,
                type: <Types.AddressType> abifyType(result.type, userDefinedTypes)
              };
          }
      }
      break; //to satisfy typescript
    }
    case "function":
      switch(result.type.visibility) {
        case "external": {
          let coercedResult = <Values.FunctionExternalResult> result;
            return {
              ...coercedResult,
              type: <Types.FunctionExternalType> abifyType(result.type, userDefinedTypes)
            };
          }
        case "internal": //these don't go in the ABI
          return undefined;
      }
      break; //to satisfy TypeScript
    case "struct": {
      let coercedResult = <Values.StructResult> result;
      switch(coercedResult.kind) {
        case "value":
          if(coercedResult.reference !== undefined) {
            return undefined; //no circular values in the ABI!
          }
          let abifiedMembers = coercedResult.value.map(
            ({name, value: member}) => ({
              name,
              value: abifyResult(member, userDefinedTypes)
            })
          );
          return {
            kind: "value",
            type: <Types.StructType> abifyType(result.type, userDefinedTypes), //note: may throw exception
            value: abifiedMembers
          };
        case "error":
          return {
            ...coercedResult,
            type: <Types.StructType> abifyType(result.type, userDefinedTypes) //note: may throw exception
          };
      }
    }
    case "enum": {
      //NOTE: this is the one case where errors are converted to non-error values!!
      //(other than recursively, I mean)
      //be aware!
      let coercedResult = <Values.EnumResult> result;
      let uintType = <Types.UintType> abifyType(result.type, userDefinedTypes); //may throw exception
      let numericValue: BN;
      switch(coercedResult.kind) {
        case "value":
          numericValue = coercedResult.value.numericAsBN.clone();
          break;
        case "error":
          switch(coercedResult.error.kind) {
            case "EnumOutOfRangeError":
            case "EnumNotFoundDecodingError":
              //group these together
              numericValue = coercedResult.error.rawAsBN.clone();
              break;
            default:
              let typeToDisplay = Types.typeString(result.type);
              throw new UnknownUserDefinedTypeError(coercedResult.type.id, typeToDisplay);
          }
          break;
      }
      //now: is it within range or not?
      if(numericValue.bitLength() <= uintType.bits) {
        return {
          type: uintType,
          kind: "value",
          value: {
            asBN: numericValue
          }
        };
      }
      else {
        //note: if we started with a value we had better not end up with an error :P
        return {
          type: uintType,
          kind: "error",
          error: {
            kind: "UintPaddingError",
            raw: ConversionUtils.toHexString(numericValue)
          }
        };
      }
    }
    case "array": {
      let coercedResult = <Values.ArrayResult> result;
      switch(coercedResult.kind) {
        case "value":
          if(coercedResult.reference !== undefined) {
            return undefined; //no circular values in the ABI!
          }
          let abifiedMembers = coercedResult.value.map(
            member => abifyResult(member, userDefinedTypes)
          );
          return {
            kind: "value",
            type: <Types.ArrayType> abifyType(result.type, userDefinedTypes),
            value: abifiedMembers
          };
        case "error":
          return {
            ...coercedResult,
            type: <Types.FunctionExternalType> abifyType(result.type, userDefinedTypes)
          };
      }
    }
    default:
      return result;
  }
}