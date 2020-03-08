﻿using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using Newtonsoft.Json.Linq;
using PostSharp.Aspects;
using PostSharp.Serialization;

namespace MAU.Attributes
{
	[AttributeUsage(AttributeTargets.Property)]
	[PSerializable]
	public sealed class UiProperty : LocationInterceptionAspect
	{
		public string PropertyName { get; private set; }

		public UiProperty(string propertyName)
		{
			PropertyName = propertyName;
		}

		public static bool HasAttribute(PropertyInfo propertyInfo)
		{
			return propertyInfo.GetCustomAttributes(typeof(UiProperty), false).Any();
		}

		public override void OnGetValue(LocationInterceptionArgs args)
		{
			// args.SetNewValue();
			Debug.WriteLine("OnGet");
			// MyAngularUi.Send();

			base.OnGetValue(args);
		}

		public override void OnSetValue(LocationInterceptionArgs args)
		{
			var holder = (UiElement)args.Instance;

			var data = new JObject
			{
				{"propName", PropertyName},
				{"propVal", args.Value.ToString()}
			};

			_ = MyAngularUi.Send(holder.Id, MyAngularUi.RequestType.SetPropValue, data);

			base.OnSetValue(args);
		}
	}
}
