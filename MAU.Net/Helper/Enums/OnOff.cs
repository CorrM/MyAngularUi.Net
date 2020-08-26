﻿using MAU.Attributes;
using System;
using System.Collections.Generic;
using System.Text;

namespace MAU.Helper.Enums
{
	public enum Off
	{
		[MauEnumMember("")]
		NotSet,

		[MauEnumMember("on")]
		On,

		[MauEnumMember("off")]
		Off
	}
}
